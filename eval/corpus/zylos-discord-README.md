# Discord Component README

## Sending Via C4

Discord messages are delivered through the communication bridge. A reply may
include routing text such as `reply via: node c4-send.js "discord" "channel"`.
This transport vocabulary is a deliberate distractor for recall evaluation and
should not be retrieved merely because a live prompt contains the routing line.

## Voice Channel Notes

The Discord voice companion receives voice audio, transcribes it, and sends the
turn through C4 so the agent can reply in Discord text.

