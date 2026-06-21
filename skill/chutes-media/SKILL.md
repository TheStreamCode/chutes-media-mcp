---
name: Chutes Media
description: This skill should be used when the user asks to "generate an image", "create a hero image", "make a video", "generate music", "create a voiceover", "text to speech", "edit this image", or otherwise produce image/video/music/speech assets inside a project. It documents the describe→generate workflow of the chutes-media-mcp tools (list_media_models, describe_media_model, generate_media) and the equivalent chutes-media CLI.
version: 0.1.0
---

# Chutes Media

Generate **image, video, music, and speech** through Chutes and save the asset directly into the
project being worked on, then reference it from the code. Use the MCP tools when they are available
(`list_media_models`, `describe_media_model`, `generate_media`); otherwise use the `chutes-media`
CLI, which exposes the same three operations and prints a JSON result to stdout.

## Golden rule

Model payloads are **never** uniform across Chutes — FLUX, Qwen-Image, Wan, LTX, ACE-Step and TTS
models each expose different fields. **Always call `describe_media_model` before `generate_media`**
for any model not already described in this session, and compose the payload from the returned
`example`. Never guess field names.

## Core workflow

Follow these steps for every generation request:

1. **Discover** — Call `list_media_models` with the target `kind` (`image` | `video` | `music` |
   `speech`) and/or a `query`. If the user named a model, skip to step 2. Models are not hardcoded
   and the catalog changes, so discover rather than assume.

2. **Describe** — Call `describe_media_model { model }`. Read the returned cords. Each cord lists its
   `required` fields, `fields` (types/defaults/ranges), and a ready-to-fill `example`; the result
   also reports a top-level `supportsEditing`. Pick the cord for the operation (generation cord by
   default).

3. **Compose** — Start from the cord's `example`, set the real `prompt`/inputs, and keep the payload
   **flat**. The server transparently unwraps function-signature schemas (e.g. an `input_args`
   wrapper) and validates the payload before spending a GPU call, returning a precise error if a
   field is wrong.

4. **Generate** — Call `generate_media { model, kind, params, cord?, output_dir?, filename? }`. The
   server warms the model, invokes it (blocking, with progress updates), retries transient cold-start
   `503`s automatically, downloads the asset, and saves it under `./assets/chutes/<kind>/` by
   default. It returns `{ path, kind, model, cord, bytes, contentType, cost?, durationMs }`.

5. **Reference** — Use the returned `path` in the project: embed the image in HTML/Markdown, wire the
   audio/video into the app, etc. Prefer a path relative to the project when referencing it in code.

## Editing existing media (img2img / inpaint / image edit)

Editing is per-model, not platform-wide. A model supports it only when `describe_media_model` reports
`supportsEditing: true` or exposes an edit cord (e.g. `img2img`, `inpaint`), or when it is a
dedicated edit model whose schema requires an image input (e.g. `image_b64s`).

To edit, reference a **workspace file path** in the relevant param (e.g. `image`, `mask`, or an array
like `image_b64s`). The server reads the file and base64-encodes it before sending — so an image
generated moments earlier can be edited by passing its saved path. Pass `cord` to select the edit
operation when the model exposes more than one.

## Iterate cheaply, then finalize

To control time and cost, draft with **fast settings first** (low `num_inference_steps`, smaller
`width`/`height`, short `duration`), review the result, then re-run with higher quality once the
prompt is right. Video and music are long-running and block until done; expect tens of seconds to a
few minutes. For an unusually long job, raise `timeout_ms` (CLI: `--timeout`) — defaults are 120s for
image/speech and 600s for video/music.

## Cold starts

Models scaled to zero return `503 "No instances available (yet)"`. The server already re-warms and
retries with backoff. If a model stays cold after retries, it has no capacity right now — pick a
different model of the same kind via `list_media_models` rather than retrying indefinitely.

## CLI equivalents

When MCP tools are unavailable, run the CLI (requires `CHUTES_API_KEY` in the environment). It prints
progress to stderr and the JSON result to stdout:

```bash
chutes-media list --kind image --query flux
chutes-media describe <owner/model-slug>
chutes-media generate --kind image --model <owner/model-slug> --params '{"prompt":"..."}'
chutes-media generate --kind image --model <edit-model> --cord img2img \
  --params '{"prompt":"make it snowy","image":"assets/chutes/image/scene.jpg"}'
```

`--params` accepts inline JSON, `@path/to/file.json`, or a path to a `.json` file.

## Additional resources

For payload-composition details per kind, troubleshooting (auth/validation/cold-start/response
shapes), cord selection, and worked end-to-end examples, consult:

- **`references/workflow.md`** — detailed workflow, per-kind field guidance, and troubleshooting.
