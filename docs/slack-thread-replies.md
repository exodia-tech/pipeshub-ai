# Continuing a Slack bot conversation

Mention an agent to start a channel conversation. Subsequent replies in that thread from the same Slack member continue their existing Brain conversation without another mention. The mapping remains scoped to the configured bot, Slack thread and verified member email; the normal Brain identity and access checks still run on each turn. Another member must mention the bot to start their own conversation rather than inheriting someone else's private Brain history.

Only established conversations are eligible. Unrelated channel messages, bot messages, root posts and unknown members are ignored. An explicit mention is answered only by the existing `app_mention` handler, avoiding two responses when Slack also delivers a `message` event. DMs continue working as before. No Slack thread-history fetch is required for an unmentioned continuation: prior turns come from the existing Brain conversation.

## Slack app configuration

Each app must deliver the relevant message events to the verified Brain webhook. `app_mention` alone delivers only mentions, not ordinary thread replies.

| Conversation | Bot event | Required scope |
| --- | --- | --- |
| Private channel | `message.groups` | `groups:history` |
| Public channel | `message.channels` | `channels:history` |
| Direct message | `message.im` | `im:history` |

Adding channel events expands the messages Slack can deliver from channels the bot has joined. An administrator must approve the required scope and reinstall the app when Slack requests it. This is separate from deploying the handler fix; code deployment alone cannot add permissions to installed Slack apps. Keep bot membership limited to intended channels. The handler discards unrelated messages before building a query or calling the model.

See Slack's [message event documentation](https://docs.slack.dev/reference/events/message/) and [private-channel event requirements](https://docs.slack.dev/reference/events/message.groups/).

## Reply presentation

Answers keep their numbered, clickable citations. A compact **Sources** list follows the answer in the same message when it fits, with one named link per source. Repeated references to the same record or URL appear once. Long answers can continue in further messages in the same thread. The bot suppresses link previews.

While a reply is generated, the activity message shows the current action and available tool progress, then “Writing reply…” when answer text starts. Incomplete links wait for their next stream chunk. The final answer replaces the streamed draft; raw model reasoning is not shown in Slack.
