/**
 * Tests the web search text block fix in coach/respond.
 *
 * Verifies that:
 * 1. Full answer is preserved when Claude splits it across a tool call
 * 2. No internal reasoning leaks in the normal case (single block, no search)
 * 3. Brief narration before a tool call ("Let me look that up") doesn't dominate
 *
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-web-search-blocks.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// The system prompt used in coach/respond for user_message triggers (simplified)
const SYSTEM_PROMPT = `You are Coach Dean, an expert endurance coach communicating via text message. You are coaching an athlete.

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include any of the following in your output:
- Internal reasoning, calculations, or self-corrections ("Wait...", "Let me recalculate...", "Actually...", "Searching for...", "Let me look that up...")
- Draft versions or abandoned attempts
- Meta-commentary about the plan
Do all reasoning silently before writing your final response. Output only the message the athlete should receive.

COMMUNICATION STYLE:
You are texting over iMessage. Write exactly like a real human coach would text.

LENGTH: Keep responses under 480 characters. Most replies should be a single short text.

TONE: Cut filler openers. Sound like a knowledgeable friend, not a customer service bot. No sign-offs.

FORMATTING: NEVER use asterisks, markdown bold/italic, bullet points, or dashes as list markers.`;

// --- Extraction logic: old vs new ---

function extractOldApproach(content) {
  const textBlocks = content.filter(b => b.type === "text");
  return textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : "";
}

function extractNewApproach(content) {
  const textBlocks = content
    .filter(b => b.type === "text")
    .map(b => b.text.trim())
    .filter(t => t.length > 0);
  return textBlocks.reduce((acc, block) => {
    if (!acc) return block;
    if (/\s$/.test(acc) || /^[,;:.!?)\]}]/.test(block)) return acc + block;
    return acc + " " + block;
  }, "");
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .trim();
}

// --- Run a test case ---

async function runTest(label, userMessage, useWebSearch) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`TEST: ${label}`);
  console.log(`Message: "${userMessage}"`);
  console.log(`Web search: ${useWebSearch}`);
  console.log("=".repeat(70));

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    ...(useWebSearch
      ? { tools: [{ type: "web_search_20250305", name: "web_search" }] }
      : {}),
  });

  // Show raw content blocks
  console.log(`\nStop reason: ${response.stop_reason}`);
  console.log(`Content blocks (${response.content.length} total):`);
  response.content.forEach((block, i) => {
    if (block.type === "text") {
      const preview = block.text.trim().slice(0, 100).replace(/\n/g, "\\n");
      console.log(`  [${i}] TEXT (${block.text.trim().length} chars): "${preview}${block.text.trim().length > 100 ? "..." : ""}"`);
    } else if (block.type === "tool_use") {
      const query = block.input?.query || JSON.stringify(block.input).slice(0, 60);
      console.log(`  [${i}] TOOL_USE: web_search("${query}")`);
    } else if (block.type === "tool_result") {
      console.log(`  [${i}] TOOL_RESULT (search results)`);
    } else {
      console.log(`  [${i}] ${block.type.toUpperCase()}`);
    }
  });

  const textBlockCount = response.content.filter(b => b.type === "text").length;
  const didSearch = response.content.some(b => b.type === "tool_use");

  // Compare old vs new extraction
  const oldRaw = extractOldApproach(response.content);
  const newRaw = extractNewApproach(response.content);
  const oldMessage = stripMarkdown(oldRaw);
  const newMessage = stripMarkdown(newRaw);

  console.log(`\n--- OLD approach (last text block only) ---`);
  if (!oldMessage.trim()) {
    console.log(`  ⚠️  EMPTY — would have sent "." via Linq`);
  } else if (oldMessage.trim().match(/^[,;.?!]/)) {
    console.log(`  ⚠️  FRAGMENT starting with punctuation: "${oldMessage.trim().slice(0, 120)}"`);
  } else {
    console.log(`  ✅ "${oldMessage.trim().slice(0, 200)}${oldMessage.length > 200 ? "..." : ""}"`);
  }

  console.log(`\n--- NEW approach (all text blocks concatenated) ---`);
  if (!newMessage.trim()) {
    console.log(`  ⚠️  Still empty — empty guard will catch this`);
  } else if (newMessage.trim().match(/^[,;.?!]/)) {
    console.log(`  ⚠️  Still starts with punctuation: "${newMessage.trim().slice(0, 120)}"`);
  } else {
    console.log(`  ✅ "${newMessage.trim().slice(0, 200)}${newMessage.length > 200 ? "..." : ""}"`);
  }

  // Show what the final SMS message would look like
  console.log(`\n--- Final SMS message (new approach, after stripMarkdown) ---`);
  if (newMessage.trim()) {
    const parts = newMessage.trim().split(/\n{2,}/);
    parts.forEach((part, i) => {
      console.log(`  Bubble ${i + 1}: "${part.trim()}"`);
    });
  }

  // Check for internal reasoning leak in new approach
  const reasoningPatterns = /let me (search|look|check|find)|searching for|i('ll| will) search|let me see|looking that up/i;
  if (newMessage && reasoningPatterns.test(newMessage)) {
    console.log(`\n  ⚠️  REASONING LEAK detected in new approach`);
    console.log(`     Matched: "${newMessage.match(reasoningPatterns)?.[0]}"`);
  } else if (newMessage) {
    console.log(`\n  ✅ No internal reasoning leak detected`);
  }

  // Result
  const oldBroken = !oldMessage.trim() || !!oldMessage.trim().match(/^[,;.?!]/);
  const newFixed = !!newMessage.trim() && !newMessage.trim().match(/^[,;.?!]/);

  if (didSearch && textBlockCount > 1) {
    if (oldBroken && newFixed) {
      console.log(`\n  🐛→✅ Bug confirmed and fixed (web search split the response, new approach recovers it)`);
    } else if (!oldBroken && newFixed) {
      console.log(`\n  ✅ Both approaches produce valid output (web search used, no split this time)`);
    } else {
      console.log(`\n  ⚠️  Both approaches have issues — inspect manually`);
    }
  } else {
    console.log(`\n  ✅ No web search split (${textBlockCount} text block${textBlockCount !== 1 ? "s" : ""}, didSearch: ${didSearch})`);
  }

  return { label, textBlockCount, didSearch, oldBroken, newFixed, newMessage };
}

// --- Main ---

async function main() {
  console.log("Coach Dean — Web Search Text Block Fix Verification");
  console.log("Testing that full answers are preserved and no internal reasoning leaks\n");

  const results = [];

  // Test 1: Question that may trigger web search — side cramps (the actual bug case)
  results.push(await runTest(
    "Side cramps question (the actual bug case)",
    "Why do side cramps happen when running and how can I prevent them?",
    true
  ));

  // Test 2: General coaching question, no web search
  results.push(await runTest(
    "General coaching question (no web search)",
    "My easy runs have been feeling hard lately, what should I do?",
    false
  ));

  // Test 3: Question likely to trigger web search — training science
  results.push(await runTest(
    "Training science question (may trigger search)",
    "What's the science behind the 80/20 training rule and does it apply to beginners?",
    true
  ));

  // Test 4: Simple acknowledgment — should return [NO_REPLY]
  results.push(await runTest(
    "Closing acknowledgment — should be [NO_REPLY]",
    "Thanks!",
    false
  ));

  // Summary
  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log("=".repeat(70));

  const bugsFound = results.filter(r => r.oldBroken && r.newFixed);
  const regressions = results.filter(r => !r.oldBroken && !r.newFixed);
  const leaks = results.filter(r => r.newMessage && /let me (search|look|check)|searching for/i.test(r.newMessage));

  console.log(`\nTests run: ${results.length}`);
  console.log(`Bugs confirmed & fixed by new approach: ${bugsFound.length}`);
  if (bugsFound.length > 0) bugsFound.forEach(r => console.log(`  - ${r.label}`));
  console.log(`Regressions (old was fine, new broke it): ${regressions.length}`);
  if (regressions.length > 0) regressions.forEach(r => console.log(`  - ${r.label}`));
  console.log(`Internal reasoning leaks in new approach: ${leaks.length}`);
  if (leaks.length > 0) leaks.forEach(r => console.log(`  - ${r.label}`));

  if (regressions.length === 0 && leaks.length === 0) {
    console.log(`\n✅ Fix is safe — no regressions and no internal reasoning leaks`);
  } else {
    console.log(`\n⚠️  Issues found — review output above`);
  }
}

main().catch(console.error);
