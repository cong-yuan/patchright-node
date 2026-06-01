const { chromium } = require("patchright");
const {
  attachConversationStreamListener,
} = require("./plugins/conversation-stream-listener");

(async () => {
  const context = await chromium.launchPersistentContext("./user-data", {
    channel: "chrome",
    headless: false,
    viewport: null,
  });

  const page = await context.newPage();
  await attachConversationStreamListener(page, { debug: true });

  await page.goto(
    "https://chatgpt.com/c/WEB:5131f56b-a35c-4e1c-bfe7-7f2b9d83a385",
    { waitUntil: "domcontentloaded" },
  );

  const questions = [
    "请用3句话解释什么是事件循环。",
    "给我一个JavaScript异步重试函数示例。简单回复",
    "如何快速定位Node.js内存泄漏？ 简单回复",
    "帮我写一个正则，提取URL里的query参数。 简单回复",
    "对比一下Promise.all和Promise.allSettled的适用场景。 简单回复",
  ];
  const question = questions[Math.floor(Math.random() * questions.length)];

  const input = page
    .locator('div[contenteditable="true"][id="prompt-textarea"]')
    .first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  await input.click();
  await input.fill(question);

  // Press Enter to send.
  await input.press("Enter");

  // Keep browser open for observation.
  await page.waitForTimeout(30000);
})();
