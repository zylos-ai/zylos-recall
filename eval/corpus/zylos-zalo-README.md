# Zalo Component README

## Sending Via C4

Zalo channel messages also use the communication bridge. Documentation examples
mention `c4-send.js`, channel identifiers, and reply routing. These terms are
near duplicates of other channel docs and should be treated as transport
plumbing, not as recall design evidence.

## Channel Setup

The component stores Zalo credentials in configuration and relays incoming
messages to the common C4 queue.

