#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_URL = "https://jwc.suibe.edu.cn/tzggwxszl/list.htm";
const DEFAULT_STATE = join(dirname(fileURLToPath(import.meta.url)), "jwc_student_notice_state.json");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126 Safari/537.36";

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  return await response.text();
}

function parseNotices(source, baseUrl = LIST_URL) {
  const notices = [];
  const liRegex = /<li\b[\s\S]*?<\/li>/gi;
  const hrefRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
  const dateRegex = /\d{4}-\d{2}-\d{2}/;

  for (const [li] of source.matchAll(liRegex)) {
    const link = li.match(hrefRegex);
    const date = li.match(dateRegex);
    if (!link || !date) continue;

    const url = new URL(link[1], baseUrl).href;
    const title = stripTags(link[2]);
    if (url.endsWith("/page.htm") && title) {
      notices.push({ title, date: date[0], url });
    }
  }

  if (notices.length === 0) {
    throw new Error("No notices found; the page structure may have changed.");
  }

  return notices;
}

async function fetchNotices() {
  return parseNotices(await fetchText(LIST_URL));
}

async function loadSeen(path) {
  if (!existsSync(path)) return new Set();
  const payload = JSON.parse(await readFile(path, "utf8"));
  return new Set(payload.seen || []);
}

async function saveSeen(path, seen) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        source: LIST_URL,
        updated_at: new Date().toISOString(),
        seen: [...new Set(seen)].sort(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function formatMarkdown(notices) {
  return [
    "### 教务处学生专栏有新通知",
    ...notices.map((item) => `- ${item.date} [${item.title}](${item.url})`),
  ].join("\n");
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Push failed: ${response.status} ${response.statusText}`);
}

async function postForm(url, payload) {
  const body = new URLSearchParams(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body,
  });
  if (!response.ok) throw new Error(`Push failed: ${response.status} ${response.statusText}`);
}

async function pushWechat(notices) {
  const markdown = formatMarkdown(notices);
  const webhook = process.env.WECHAT_WEBHOOK_URL;
  const serverChanKey = process.env.SERVERCHAN_SENDKEY;
  const pushPlusToken = process.env.PUSHPLUS_TOKEN;

  if (webhook) {
    await postJson(webhook, { msgtype: "markdown", markdown: { content: markdown } });
    return;
  }

  if (serverChanKey) {
    await postForm(`https://sctapi.ftqq.com/${serverChanKey}.send`, {
      title: "教务处学生专栏有新通知",
      desp: markdown,
    });
    return;
  }

  if (pushPlusToken) {
    await postJson("https://www.pushplus.plus/send", {
      token: pushPlusToken,
      title: "教务处学生专栏有新通知",
      content: markdown,
      template: "markdown",
    });
    return;
  }

  throw new Error("No push channel configured. Set WECHAT_WEBHOOK_URL, SERVERCHAN_SENDKEY, or PUSHPLUS_TOKEN.");
}

async function checkOnce({ statePath, dryRun, initSend }) {
  const notices = await fetchNotices();
  const seen = await loadSeen(statePath);
  const currentKeys = new Set(notices.map((notice) => notice.url));

  if (seen.size === 0 && !initSend) {
    await saveSeen(statePath, currentKeys);
    console.log(`Initialized baseline with ${notices.length} notices. No push sent.`);
    return 0;
  }

  const newNotices = notices.filter((notice) => !seen.has(notice.url));
  if (newNotices.length === 0) {
    await saveSeen(statePath, new Set([...seen, ...currentKeys]));
    console.log("No new notices.");
    return 0;
  }

  console.log(formatMarkdown(newNotices));
  if (!dryRun) await pushWechat(newNotices);
  await saveSeen(statePath, new Set([...seen, ...currentKeys]));
  console.log(`Pushed ${newNotices.length} new notice(s).`);
  return newNotices.length;
}

function parseArgs(argv) {
  const args = { statePath: DEFAULT_STATE, dryRun: false, initSend: false, dump: false, interval: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") args.statePath = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--init-send") args.initSend = true;
    else if (arg === "--dump") args.dump = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--interval") args.interval = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node jwc_student_notice_monitor.mjs [--once] [--dump] [--dry-run] [--init-send] [--interval seconds] [--state path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.dump) {
  console.log(JSON.stringify(await fetchNotices(), null, 2));
} else if (args.interval > 0) {
  for (;;) {
    try {
      await checkOnce(args);
    } catch (error) {
      console.error(`Check failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.interval * 1000));
  }
} else {
  await checkOnce(args);
}
