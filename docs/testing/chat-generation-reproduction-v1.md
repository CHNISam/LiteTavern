# Chat generation reproduction v1

This procedure captures enough evidence to locate repeated, overlong, or corrupted
assistant text without exporting conversation content or API keys.

## Enable and capture one turn

1. Open LiteTavern with `?generation_trace=1` appended to the URL.
2. Confirm the bottom-left **Generation trace enabled** indicator is visible.
3. Send one input from
   `apps/web/src/test/fixtures/generation-reproduction-v1.json`.
4. When the indicator changes to **Generation trace ready**, choose **Export trace**.
5. Save a screenshot of the rendered assistant turn beside the JSON file.

The JSON contains IDs, provider/model, normalized generation configuration, usage,
finish state, SSE sequence numbers, lengths, and SHA-256 hashes. It contains no raw
prompt, user message, assistant message, card text, credential, or BYOK key.

## Matrix

Run every fixed input at least three times in a new conversation, then once in an
existing conversation. Cover Platform and BYOK on desktop. Repeat the four inputs plus
a normal 10–20 turn conversation on iPhone Safari. Record the Character Card revision,
whether the conversation was new, and the screenshot time in the submission note.

## Reading the layers

- `request_input` identifies the fixed input by hash and length.
- `prompt_compiler_output` identifies the exact logical prompt without revealing it.
- `provider_adapter_output` is what the AI SDK text adapter yielded.
- `effective_body_assembler` is the Worker-visible assistant body.
- `sse_output` is the ordered text attached to sequenced delta frames.
- `persistence_input` is the text handed to D1 settlement.
- `client.assembled`, `runtime_input`, and `ui_message` cover browser parsing and the
  value handed to React.

The first adjacent pair whose hash or length differs identifies the first divergent
layer. Identical repeated text with different `seq` values is intentional protocol data;
the client only suppresses a replay of the same sequence number and never deduplicates
by text.
