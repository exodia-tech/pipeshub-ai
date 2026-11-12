import { isIgnoredSlackMessage, isThreadFollowUpMessage, resolveOwnBotIdentity, type SlackMessagePayload, type TypedSlackClient } from './helpers';
import { getFromDatabase } from './utils/conversation';

export async function shouldHandleSlackMessage(
  message: SlackMessagePayload,
  client: TypedSlackClient,
  context: { botUserId?: string },
  botId?: string,
): Promise<boolean> {
  if (isIgnoredSlackMessage(message, context)) return false;
  if (message.channel?.startsWith('D')) return true;
  const threadId = message.thread_ts;
  if (!message.user || !message.channel || !/^[CG]/.test(message.channel) || !botId || !threadId || !isThreadFollowUpMessage(message)) return false;

  const own = await resolveOwnBotIdentity(client, botId, context.botUserId);
  if (!own.userId || message.user === own.userId) return false;
  // Explicit mentions arrive separately as app_mention; only that handler answers them.
  if (message.text?.includes(`<@${own.userId}>`) || message.text?.includes(`<@${own.userId}|`)) return false;

  try {
    const member = await client.users.info({ user: message.user });
    const email = member.user?.profile?.email;
    // Another participant must mention the bot to start their own ACL-checked conversation.
    return Boolean(email && await getFromDatabase(threadId, botId, email));
  } catch (error) {
    // Eligibility is unknown: never send an error reply into an unrelated channel thread.
    console.error('Unable to verify Slack thread continuation:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}
