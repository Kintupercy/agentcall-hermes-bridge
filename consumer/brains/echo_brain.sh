#!/bin/sh
# The smallest possible brain. Reads the relay payload on stdin, writes a reply
# on stdout. Useful for proving the plumbing before you wire in a real agent:
#
#   "brain": { "mode": "command", "command": ["/opt/agentcall-sms-consumer/brains/echo_brain.sh"] }
#
# Payload shape (one JSON object):
#   {
#     "message":      {"id","from","to","body","receivedAt"},
#     "conversation": {"id","contactPhone"},
#     "context":      {"channel":"sms","numberId","agentId"},
#     "history":      [{"direction","body","createdAt"}, ...]   oldest first
#     "selftest":     false
#   }
#
# Contract:
#   exit 0  + text on stdout -> that text is sent as the reply
#   exit 64 + no output      -> deliberately say nothing (acked, nothing sent)
#   any other exit           -> failure; the text is redelivered and retried

set -eu

payload=$(cat)

# Pull message.body out with shell parameter expansion. ${var#pattern} strips
# the SHORTEST matching prefix, so this stops at the first "body" (the one in
# `message`, which the consumer always serialises first) instead of running on
# to the ones in `history` the way a greedy sed/grep would.
#
# It is deliberately dependency-free rather than correct in general: a body
# containing an escaped quote will be cut short. Use jq (or the python3 the
# consumer already requires) in a brain you actually ship.
rest=${payload#*\"body\":}
rest=${rest# }
rest=${rest#\"}
body=${rest%%\"*}

printf 'Echo: %s' "$body"
