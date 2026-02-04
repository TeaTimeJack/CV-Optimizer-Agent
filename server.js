const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const Anthropic = require("@anthropic-ai/sdk");
const Groq = require("groq-sdk");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { log } = require("console");
require("dotenv").config();

const CONVERSATIONS_DIR = path.join(__dirname, "conversations");
if (!fs.existsSync(CONVERSATIONS_DIR)) {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const app = express();
const PORT = process.env.PORT || 3055;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

const anthropic = AI_PROVIDER === "anthropic"
  ? new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const groq = AI_PROVIDER === "groq"
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

console.log(`AI Provider: ${AI_PROVIDER}`);

/**
 * Unified chat completion that works with both Anthropic and Groq.
 * @param {object} opts
 * @param {string} [opts.system] - System prompt (optional)
 * @param {Array} opts.messages - Array of {role, content} messages
 * @param {number} [opts.maxTokens=4096] - Max tokens
 * @returns {Promise<string>} The assistant's response text
 */
async function chatCompletion({ system, messages, maxTokens = 4096 }) {
  if (AI_PROVIDER === "groq") {
    const groqMessages = [];
    if (system) {
      groqMessages.push({ role: "system", content: system });
    }
    groqMessages.push(...messages);

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: maxTokens,
      messages: groqMessages,
    });
    console.log("tokens used:", response.usage);
    return response.choices[0].message.content;
  }

  // Default: Anthropic
  const params = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages,
  };
  if (system) {
    params.system = system;
  }
  const response = await anthropic.messages.create(params);
    console.log("tokens used:", response.usage);
  return response.content[0].text;
}


app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Preference memory ---

const MEMORY_PATH = path.join(__dirname, "memory.json");

function loadPreferences() {
  if (!fs.existsSync(MEMORY_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
    return data.preferences || [];
  } catch {
    return [];
  }
}

function savePreference(rule, sourceConversationId) {
  const prefs = loadPreferences();
  // Avoid duplicates (simple substring check)
  const isDuplicate = prefs.some(
    (p) => p.rule.toLowerCase() === rule.toLowerCase(),
  );
  if (isDuplicate) return;
  prefs.push({
    rule,
    source: sourceConversationId,
    addedAt: new Date().toISOString(),
  });
  fs.writeFileSync(
    MEMORY_PATH,
    JSON.stringify({ preferences: prefs }, null, 2),
    "utf8",
  );
  console.log("New preference saved:", rule);
}

function getPreferencesBlock() {
  const prefs = loadPreferences();
  if (prefs.length === 0) return "";
  const rules = prefs.map((p, i) => `${i + 1}. ${p.rule}`).join("\n");
  return `\n\nUSER PREFERENCES (learned from past conversations - ALWAYS apply these):\n${rules}`;
}

// --- Preference extraction (background, non-blocking) ---

async function extractPreferenceInBackground(userMessage, conversationId) {
  try {
    const existing = loadPreferences();
    const existingRules = existing.map((p) => p.rule).join("\n");

    const result = (await chatCompletion({
      maxTokens: 200,
      messages: [
        {
          role: "user",
          content: `Analyze this CV refinement request from a user. Determine if it contains a REUSABLE style/formatting preference that should be automatically applied to ALL future CV optimizations.

A reusable preference is a general formatting/style rule, NOT a content-specific change for one CV.

REUSABLE examples: "make links clickable", "use bold for job titles", "keep it to one page", "put name and role on same line"
NOT reusable examples: "add my phone number", "remove the education section", "change the company name"

User's request: "${userMessage}"

${existingRules ? `Already saved preferences (do NOT duplicate):\n${existingRules}\n` : ""}
If this IS a reusable preference, respond with ONLY the rule as a concise instruction (e.g. "Always make URLs clickable with target=_blank to open in new tabs").
If this is NOT a reusable preference, respond with exactly: NONE`,
        },
      ],
    })).trim();
    if (result !== "NONE" && result.length > 5 && result.length < 200) {
      savePreference(result, conversationId);
    }
  } catch (err) {
    console.error("Preference extraction failed (non-critical):", err.message);
  }
}

// --- Conversation helpers ---

function generateConversationId() {
  const timestamp = Date.now();
  const randomPart = crypto.randomBytes(3).toString("hex");
  return `conv_${timestamp}_${randomPart}`;
}

function getConversationPath(id) {
  const sanitized = id.replace(/[^a-zA-Z0-9_]/g, "");
  return path.join(CONVERSATIONS_DIR, `${sanitized}.json`);
}

function loadConversation(id) {
  const filePath = getConversationPath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveConversation(conversation) {
  const filePath = getConversationPath(conversation.id);
  conversation.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(conversation, null, 2), "utf8");
}

function extractHtmlFromResponse(text) {
  const doctypeIndex = text.indexOf("<!DOCTYPE html>");
  if (doctypeIndex !== -1) return text.slice(doctypeIndex);
  const htmlIndex = text.indexOf("<html");
  if (htmlIndex !== -1) return text.slice(htmlIndex);
  return null;
}

// --- Puppeteer browser singleton ---

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({ headless: true });
  }
  return browserInstance;
}

async function generatePdfFromHtml(htmlContent) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "networkidle0" });
  const pdfData = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });
  await page.close();
  return Buffer.from(pdfData);
}

process.on("SIGINT", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

// --- POST /api/analyze - Initial CV optimization (creates conversation) ---

app.post("/api/analyze", upload.single("resume"), async (req, res) => {
  console.log("--- Request received ---");
  try {
    const { jobPosition, company, jobDescription } = req.body;
    console.log("Fields:", { jobPosition, company, hasJD: !!jobDescription });
    console.log("File:", req.file ? req.file.originalname : "NO FILE");

    if (!req.file) {
      return res.status(400).json({ error: "Please upload a PDF resume" });
    }
    if (!jobPosition || !company || !jobDescription) {
      return res
        .status(400)
        .json({
          error: "Job position, company, and job description are required",
        });
    }

    console.log("Parsing PDF...");
    const pdfData = await pdfParse(req.file.buffer);
    const resumeText = pdfData.text;
    console.log("PDF parsed, text length:", resumeText.length);

    if (!resumeText.trim()) {
      return res.status(400).json({
        error:
          "Could not extract text from the PDF. Make sure it is not scanned/image-based.",
      });
    }

    console.log("Calling AI API...");
    const prefsBlock = getPreferencesBlock();
    const fullResponse = await chatCompletion({
      messages: [
        {
          role: "user",
          content: `You are a professional CV/resume optimizer. I will give you a resume and a target job description.

Your task:
1. Analyze the structure, sections, and layout of the original resume below.
2. Rewrite and optimize the resume content to better match the target job description.
3. IMPORTANT: Do NOT add any skills, technologies, or experiences that are not already present in the original resume. Only improve wording, emphasis, ordering, and presentation of existing content.
4. Keep the same sections and structure as the original.${prefsBlock}

Your response MUST have two parts, separated by the exact marker ---HTML_START---:
Part 1: A brief summary of the optimizations you made (2-4 sentences).
Part 2: The complete HTML document with inline CSS starting with <!DOCTYPE html>.

The HTML must:
- Reproduce the same visual structure and section layout as the original resume
- Use clean, professional styling (fonts, spacing, colors) similar to the original
- Be designed to fit on exactly ONE printed A4 page (use appropriate font sizes and margins)
- Contain the optimized resume content

Target position: ${jobPosition} at ${company}

Job description:
${jobDescription}

Original resume:
${resumeText}`,
        },
      ],
    });

    console.log("AI API responded successfully");

    // Parse response into explanation + HTML
    let explanation = "";
    let htmlContent = "";
    const separatorIndex = fullResponse.indexOf("---HTML_START---");
    if (separatorIndex !== -1) {
      explanation = fullResponse.slice(0, separatorIndex).trim();
      htmlContent = fullResponse
        .slice(separatorIndex + "---HTML_START---".length)
        .trim();
    } else {
      htmlContent = extractHtmlFromResponse(fullResponse) || fullResponse;
      explanation = "Your CV has been optimized for the target position.";
    }

    console.log("Generating PDF with Puppeteer...");
    const pdfBuffer = await generatePdfFromHtml(htmlContent);
    console.log("PDF generated, size:", pdfBuffer.length, "bytes");

    // Create conversation record
    const conversationId = generateConversationId();
    const conversation = {
      id: conversationId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      jobPosition,
      company,
      jobDescription,
      originalResumeText: resumeText,
      originalFileName: req.file.originalname,
      currentHtml: htmlContent,
      messages: [
        {
          role: "user",
          content: "Optimize my CV for this position.",
          timestamp: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: explanation,
          timestamp: new Date().toISOString(),
        },
      ],
    };
    saveConversation(conversation);
    console.log("Conversation created:", conversationId);

    res.json({
      conversationId,
      explanation,
      pdfBase64: pdfBuffer.toString("base64"),
    });
  } catch (err) {
    console.error("ANALYSIS ERROR:", err.message || err);
    if (err.status) console.error("HTTP Status:", err.status);
    if (err.error) console.error("API Error:", JSON.stringify(err.error));
    if (err.message === "Only PDF files are allowed") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: `Analysis failed: ${err.message}` });
  }
});

// --- GET /api/conversations - List all conversations ---

app.get("/api/conversations", async (req, res) => {
  try {
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
      return res.json([]);
    }
    const files = fs
      .readdirSync(CONVERSATIONS_DIR)
      .filter((f) => f.endsWith(".json"));
    const conversations = files
      .map((f) => {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(CONVERSATIONS_DIR, f), "utf8"),
          );
          return {
            id: data.id,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            jobPosition: data.jobPosition,
            company: data.company,
            originalFileName: data.originalFileName,
            messageCount: data.messages.length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json(conversations);
  } catch (err) {
    console.error("LIST ERROR:", err.message);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

// --- GET /api/conversations/:id - Load a single conversation ---

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conversation = loadConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json({
      id: conversation.id,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      jobPosition: conversation.jobPosition,
      company: conversation.company,
      jobDescription: conversation.jobDescription,
      originalFileName: conversation.originalFileName,
      currentHtml: conversation.currentHtml,
      messages: conversation.messages,
    });
  } catch (err) {
    console.error("LOAD ERROR:", err.message);
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

// --- POST /api/conversations/:id/message - Refinement message ---

app.post("/api/conversations/:id/message", async (req, res) => {
  try {
    const conversation = loadConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    console.log(
      `Refinement for ${conversation.id}: "${message.trim().slice(0, 80)}..."`,
    );

    // Build messages with sliding window history
    const prefsBlock = getPreferencesBlock();
    const systemPrompt = `You are a professional CV/resume optimizer in an iterative refinement conversation.

RULES:
1. NEVER add skills, technologies, or experiences not present in the original resume.
2. Modify the current CV HTML based on the user's request.
3. Your response MUST have these parts, separated by exact markers:
   Part 1: A brief explanation of what you changed (2-4 sentences).
   Then the marker ---HTML_START---
   Part 2: The complete updated HTML document starting with <!DOCTYPE html>.
   Then optionally, if the user's request represents a REUSABLE style/formatting preference that should apply to ALL future CVs (not a one-off change specific to this CV's content), add:
   ---PREFERENCE---
   A single concise rule (e.g. "Always make URLs clickable with target=_blank")
4. The HTML must be a complete, self-contained document with inline CSS that fits on exactly ONE printed A4 page.
5. Always output the FULL HTML document, not a partial diff.${prefsBlock}`;

    const messages = [];

    // First message: context with original resume + job description
    messages.push({
      role: "user",
      content: `Original resume text:\n${conversation.originalResumeText}\n\nTarget position: ${conversation.jobPosition} at ${conversation.company}\n\nJob description:\n${conversation.jobDescription}\n\nPlease help me optimize this CV.`,
    });

    // First assistant response
    if (conversation.messages.length >= 2) {
      messages.push({
        role: "assistant",
        content:
          conversation.messages[1].content +
          "\n\n---HTML_START---\n\n" +
          conversation.currentHtml,
      });
    }

    // Add recent history pairs (skip first pair, sliding window of last 5)
    const MAX_HISTORY_PAIRS = 5;
    const historyPairs = [];
    for (let i = 2; i < conversation.messages.length; i += 2) {
      if (conversation.messages[i] && conversation.messages[i + 1]) {
        historyPairs.push([
          conversation.messages[i],
          conversation.messages[i + 1],
        ]);
      }
    }
    const recentPairs = historyPairs.slice(-MAX_HISTORY_PAIRS);
    for (const [userMsg, assistantMsg] of recentPairs) {
      messages.push({ role: "user", content: userMsg.content });
      messages.push({ role: "assistant", content: assistantMsg.content });
    }

    // Final message: current HTML + new request
    messages.push({
      role: "user",
      content: `Current CV HTML:\n${conversation.currentHtml}\n\nPlease make the following change: ${message.trim()}`,
    });

    console.log("Calling AI API for refinement...");
    const fullResponse = await chatCompletion({
      system: systemPrompt,
      messages,
    });

    let explanation = "";
    let htmlContent = "";
    let preferenceRule = "";

    const separatorIndex = fullResponse.indexOf("---HTML_START---");
    if (separatorIndex !== -1) {
      explanation = fullResponse.slice(0, separatorIndex).trim();
      let rest = fullResponse
        .slice(separatorIndex + "---HTML_START---".length)
        .trim();

      // Check for preference marker
      const prefIndex = rest.indexOf("---PREFERENCE---");
      if (prefIndex !== -1) {
        htmlContent = rest.slice(0, prefIndex).trim();
        preferenceRule = rest
          .slice(prefIndex + "---PREFERENCE---".length)
          .trim();
      } else {
        htmlContent = rest;
      }
    } else {
      htmlContent =
        extractHtmlFromResponse(fullResponse) || conversation.currentHtml;
      explanation =
        fullResponse.replace(htmlContent, "").trim() || "Changes applied.";
    }

    // Save learned preference if one was extracted from the response
    if (preferenceRule) {
      savePreference(preferenceRule, conversation.id);
    }

    console.log("Generating refined PDF...");
    const pdfBuffer = await generatePdfFromHtml(htmlContent);

    // Update conversation
    conversation.currentHtml = htmlContent;
    conversation.messages.push({
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString(),
    });
    conversation.messages.push({
      role: "assistant",
      content: explanation,
      timestamp: new Date().toISOString(),
    });
    saveConversation(conversation);

    res.json({
      explanation,
      pdfBase64: pdfBuffer.toString("base64"),
    });

    // Background: extract preference from user message (non-blocking)
    extractPreferenceInBackground(message.trim(), conversation.id);
  } catch (err) {
    console.error("REFINEMENT ERROR:", err.message || err);
    if (err.status) console.error("HTTP Status:", err.status);
    if (err.error) console.error("API Error:", JSON.stringify(err.error));
    res.status(500).json({ error: `Refinement failed: ${err.message}` });
  }
});

// --- GET /api/conversations/:id/pdf - Download current PDF ---

app.get("/api/conversations/:id/pdf", async (req, res) => {
  try {
    const conversation = loadConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const pdfBuffer = await generatePdfFromHtml(conversation.currentHtml);
    const filename = `optimized-cv-${conversation.jobPosition.replace(/\s+/g, "-").toLowerCase()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF ERROR:", err.message);
    res.status(500).json({ error: `PDF generation failed: ${err.message}` });
  }
});

// --- DELETE /api/conversations/:id ---

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    const filePath = getConversationPath(req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ERROR:", err.message);
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

// --- Server startup ---

const server = app.listen(PORT, () => {
  console.log(`CV Optimizer running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  console.error("Server error:", err);
});
