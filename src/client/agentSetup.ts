export function buildAgentSetupPrompt(origin: string): string {
  const siteOrigin = origin.replace(/\/+$/, "");

  return `Set up my recurring housing search with Homing.

Read ${siteOrigin}/agent/ and follow it exactly. It tells you everything, including how to get access to my account without me pasting anything secret into this chat.

Before you ask me anything, work out your own setup yourself: what tools, storage, network, scheduling and secure storage you have. Then ask me only what you genuinely cannot find out on your own. Plain words, one thing at a time, at most three, each with a sensible default I can accept by saying "yes".

Never put a password or an access key into this chat.

If you cannot read that page, tell me plainly and stop. Do not improvise.

When you are done, tell me in a few plain sentences what you set up, how often it will run, and how I stop it.`;
}
