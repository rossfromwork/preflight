export async function sendSlackDigest(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
  }
}
