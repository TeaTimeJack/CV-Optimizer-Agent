// --- Application State ---

const state = {
  currentView: "upload",
  conversationId: null,
  currentPdfBlobUrl: null,
  messages: [],
  isLoading: false,
  jobPosition: "",
  company: "",
};

// --- DOM Elements ---

// Upload form
const form = document.getElementById("analyze-form");
const fileInput = document.getElementById("resume");
const fileLabel = document.getElementById("file-label");
const fileUploadArea = document.getElementById("file-upload-area");
const submitBtn = document.getElementById("submit-btn");
const btnText = submitBtn.querySelector(".btn-text");
const spinner = submitBtn.querySelector(".spinner");
const errorDiv = document.getElementById("error");

// Conversation
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const chatPosition = document.getElementById("chat-position");
const chatCompany = document.getElementById("chat-company");
const pdfPreview = document.getElementById("pdf-preview");

// Navigation
const historyBtn = document.getElementById("history-btn");
const historyCloseBtn = document.getElementById("history-close-btn");
const historyOverlay = document.getElementById("history-overlay");
const historyList = document.getElementById("history-list");
const backBtn = document.getElementById("back-btn");
const newBtn = document.getElementById("new-btn");
const downloadBtn = document.getElementById("download-btn");
const previewDownloadBtn = document.getElementById("preview-download-btn");

// --- View Management ---

function showView(viewName) {
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.remove("active");
  });
  const target = document.getElementById(`view-${viewName}`);
  if (target) {
    target.classList.add("active");
  }
  state.currentView = viewName;
}

// --- PDF Preview ---

function updatePdfPreview(base64Pdf) {
  if (state.currentPdfBlobUrl) {
    URL.revokeObjectURL(state.currentPdfBlobUrl);
    state.currentPdfBlobUrl = null;
  }

  const byteCharacters = atob(base64Pdf);
  const byteNumbers = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const blob = new Blob([byteNumbers], { type: "application/pdf" });
  state.currentPdfBlobUrl = URL.createObjectURL(blob);
  pdfPreview.src = state.currentPdfBlobUrl;
}

// --- Chat Messages ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderMessages(messages) {
  chatMessages.innerHTML = "";
  messages.forEach((msg) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${msg.role}`;
    bubble.innerHTML = escapeHtml(msg.content);

    if (msg.timestamp) {
      const ts = document.createElement("div");
      ts.className = "timestamp";
      ts.textContent = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      bubble.appendChild(ts);
    }

    chatMessages.appendChild(bubble);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendMessage(role, content) {
  state.messages.push({ role, content, timestamp: new Date().toISOString() });
  renderMessages(state.messages);
}

function showTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.id = "typing-indicator";
  indicator.innerHTML = "<span></span><span></span><span></span>";
  chatMessages.appendChild(indicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) indicator.remove();
}

// --- File Upload UI ---

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    fileLabel.textContent = fileInput.files[0].name;
    fileUploadArea.classList.add("has-file");
  } else {
    fileLabel.textContent = "Click or drag to upload PDF";
    fileUploadArea.classList.remove("has-file");
  }
});

fileUploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileUploadArea.classList.add("dragover");
});

fileUploadArea.addEventListener("dragleave", () => {
  fileUploadArea.classList.remove("dragover");
});

fileUploadArea.addEventListener("drop", () => {
  fileUploadArea.classList.remove("dragover");
});

// --- Form Submission (Initial Optimization) ---

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.isLoading) return;
  state.isLoading = true;

  errorDiv.classList.add("hidden");

  const formData = new FormData();
  formData.append("resume", fileInput.files[0]);
  formData.append("jobPosition", document.getElementById("jobPosition").value.trim());
  formData.append("company", document.getElementById("company").value.trim());
  formData.append("jobDescription", document.getElementById("jobDescription").value.trim());

  submitBtn.disabled = true;
  btnText.textContent = "Generating optimized CV...";
  spinner.classList.remove("hidden");

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Something went wrong");
    }

    const data = await res.json();

    // Set state
    state.conversationId = data.conversationId;
    state.jobPosition = document.getElementById("jobPosition").value.trim();
    state.company = document.getElementById("company").value.trim();
    state.messages = [
      { role: "user", content: "Optimize my CV for this position.", timestamp: new Date().toISOString() },
      { role: "assistant", content: data.explanation, timestamp: new Date().toISOString() },
    ];

    // Update conversation view
    chatPosition.textContent = state.jobPosition;
    chatCompany.textContent = `at ${state.company}`;

    renderMessages(state.messages);
    updatePdfPreview(data.pdfBase64);

    showView("conversation");
  } catch (err) {
    errorDiv.textContent = err.message;
    errorDiv.classList.remove("hidden");
  } finally {
    state.isLoading = false;
    submitBtn.disabled = false;
    btnText.textContent = "Analyze";
    spinner.classList.add("hidden");
  }
});

// --- Chat Send ---

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || state.isLoading || !state.conversationId) return;

  state.isLoading = true;
  chatSendBtn.disabled = true;
  chatSendBtn.querySelector(".btn-text").textContent = "...";
  chatSendBtn.querySelector(".spinner").classList.remove("hidden");

  // Show user message immediately
  appendMessage("user", message);
  chatInput.value = "";

  // Show typing indicator
  showTypingIndicator();

  try {
    const res = await fetch(`/api/conversations/${state.conversationId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    removeTypingIndicator();

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Refinement failed");
    }

    const data = await res.json();

    // Show assistant response
    appendMessage("assistant", data.explanation);

    // Update PDF preview
    updatePdfPreview(data.pdfBase64);
  } catch (err) {
    removeTypingIndicator();
    appendMessage("assistant", `Error: ${err.message}`);
  } finally {
    state.isLoading = false;
    chatSendBtn.disabled = false;
    chatSendBtn.querySelector(".btn-text").textContent = "Send";
    chatSendBtn.querySelector(".spinner").classList.add("hidden");
  }
}

chatSendBtn.addEventListener("click", sendChatMessage);

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// --- Download ---

function downloadCurrentPdf() {
  if (!state.conversationId) return;
  const a = document.createElement("a");
  a.href = `/api/conversations/${state.conversationId}/pdf`;
  const slug = state.jobPosition.replace(/\s+/g, "-").toLowerCase();
  a.download = `optimized-cv-${slug}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

downloadBtn.addEventListener("click", downloadCurrentPdf);
previewDownloadBtn.addEventListener("click", downloadCurrentPdf);

// --- History ---

async function openHistory() {
  historyOverlay.classList.remove("hidden");
  historyList.innerHTML = '<div class="history-empty">Loading...</div>';

  try {
    const res = await fetch("/api/conversations");
    const conversations = await res.json();

    if (conversations.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
      return;
    }

    historyList.innerHTML = "";
    conversations.forEach((conv) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="history-item-position">${escapeHtml(conv.jobPosition)}</div>
        <div class="history-item-company">at ${escapeHtml(conv.company)}</div>
        <div class="history-item-meta">
          <span>${new Date(conv.updatedAt).toLocaleDateString()} - ${conv.messageCount} messages</span>
          <button class="history-item-delete" data-id="${escapeHtml(conv.id)}" title="Delete">Delete</button>
        </div>
      `;

      // Click on item to resume (but not on delete button)
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("history-item-delete")) return;
        resumeConversation(conv.id);
      });

      // Delete button
      const deleteBtn = item.querySelector(".history-item-delete");
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete conversation for "${conv.jobPosition}"?`)) return;
        try {
          await fetch(`/api/conversations/${conv.id}`, { method: "DELETE" });
          item.remove();
          if (historyList.children.length === 0) {
            historyList.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
          }
        } catch {
          // Silently fail
        }
      });

      historyList.appendChild(item);
    });
  } catch {
    historyList.innerHTML = '<div class="history-empty" style="color:#dc2626;">Failed to load history.</div>';
  }
}

function closeHistory() {
  historyOverlay.classList.add("hidden");
}

async function resumeConversation(conversationId) {
  closeHistory();

  try {
    const res = await fetch(`/api/conversations/${conversationId}`);
    if (!res.ok) throw new Error("Failed to load conversation");
    const conv = await res.json();

    state.conversationId = conv.id;
    state.jobPosition = conv.jobPosition;
    state.company = conv.company;
    state.messages = conv.messages;

    chatPosition.textContent = conv.jobPosition;
    chatCompany.textContent = `at ${conv.company}`;

    renderMessages(conv.messages);

    // Generate PDF preview from the server
    const pdfRes = await fetch(`/api/conversations/${conversationId}/pdf`);
    if (!pdfRes.ok) throw new Error("Failed to generate PDF");
    const pdfBlob = await pdfRes.blob();
    if (state.currentPdfBlobUrl) URL.revokeObjectURL(state.currentPdfBlobUrl);
    state.currentPdfBlobUrl = URL.createObjectURL(pdfBlob);
    pdfPreview.src = state.currentPdfBlobUrl;

    showView("conversation");
  } catch (err) {
    alert("Failed to resume conversation: " + err.message);
  }
}

historyBtn.addEventListener("click", openHistory);
historyCloseBtn.addEventListener("click", closeHistory);
historyOverlay.addEventListener("click", (e) => {
  if (e.target === historyOverlay) closeHistory();
});

// --- Navigation ---

backBtn.addEventListener("click", () => {
  showView("upload");
});

newBtn.addEventListener("click", () => {
  state.conversationId = null;
  state.messages = [];
  if (state.currentPdfBlobUrl) {
    URL.revokeObjectURL(state.currentPdfBlobUrl);
    state.currentPdfBlobUrl = null;
  }
  pdfPreview.src = "";
  chatMessages.innerHTML = "";
  showView("upload");
});
