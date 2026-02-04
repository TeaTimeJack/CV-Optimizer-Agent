# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CV Optimizer Agent - a Node.js web app that takes a user's PDF resume and a target job description, uses Claude AI to optimize the resume content, and returns a downloadable single-page A4 PDF. The key constraint is that the optimizer must never add skills or experiences not present in the original resume.

## Commands

```bash
npm install      # Install dependencies
npm start        # Start server (or: node server.js)
```

Server runs at http://localhost:3050 by default.

## Architecture

**Request flow:** Browser → `POST /api/analyze` → pdf-parse extracts text → Claude generates optimized HTML → Puppeteer converts HTML to PDF → PDF returned as download

**Backend (`server.js`):**
- Express 5 server with a single API endpoint (`POST /api/analyze`)
- Multer handles PDF uploads in memory (no disk writes, 10MB limit)
- pdf-parse v1.1.1 extracts text from uploaded PDF buffer
- Anthropic SDK sends resume text + job details to Claude (claude-sonnet-4-20250514, max 4096 tokens)
- Claude is prompted to return a complete HTML document with inline CSS matching the original CV structure
- Puppeteer renders the HTML and outputs a single-page A4 PDF with zero margins

**Frontend (`public/`):**
- Vanilla HTML/CSS/JS, no build step
- Form with PDF upload (drag-and-drop), job position, company, job description fields
- On submit, sends FormData to `/api/analyze`, receives a PDF blob, triggers browser download

## Key Constraints

- The Anthropic SDK is imported as `require("@anthropic-ai/sdk")` and instantiated via `new Anthropic.default({...})` (CommonJS)
- pdf-parse must stay at v1.1.1 — v2 has an incompatible class-based API
- The `.env` file must contain `ANTHROPIC_API_KEY`
