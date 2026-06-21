# Chutes Media — detailed workflow & troubleshooting

This reference expands the SKILL.md workflow with per-kind field guidance, response handling, cord
selection, and troubleshooting. Load it when composing a non-trivial payload or diagnosing a failure.

## Reading `describe_media_model` output

The describe result has this shape:

```jsonc
{
  "model": "owner/model-slug",
  "kind": "image",                    // best-effort inference; trust the chosen kind argument
  "invokeBaseUrl": "https://<slug>.chutes.ai",
  "supportsEditing": false,           // true when an img2img/inpaint cord exists
  "cords": [
    {
      "name": "generate",             // operation name; pass as `cord` to target it
      "method": "POST",
      "outputContentType": "image/png",
      "required": ["prompt"],
      "fields": { "prompt": { "type": "string" }, "width": { "type": "integer", "default": 1024 } },
      "example": { "prompt": "your text here", "width": 1024, "height": 1024 }
    }
  ]
}
```

Compose `params` from `example`: replace placeholders with real values, keep only what is needed
(defaults cover the rest), and stay flat. The server validates `params` against the live schema
before invoking and returns a structured error naming each field to fix — so a rejected payload costs
no GPU time.

## Per-kind field guidance

These are common fields; the live schema is authoritative. Always defer to `describe_media_model`.

### Image
- Core: `prompt` (required), `width`, `height`, `num_inference_steps`, `guidance_scale`/`true_cfg_scale`, `seed`, `negative_prompt`.
- Draft fast with low steps (e.g. 8–12) and 512–768 px; finalize at 1024 px with 20–30 steps.

### Image editing
- Dedicated edit models require an input image, often as an **array** (`image_b64s`) or a single
  field (`image`). Reference a workspace path; the server base64-encodes it.
- Edit cords on a generation model (`img2img`, `inpaint`) take `image`, optional `mask`, and a
  `strength`/`denoise` field. Select them with `cord`.

### Video
- Core: `prompt` (required), `duration` or `num_frames`/`frames`, `fps`, `width`, `height`, `seed`.
- Image-to-video models accept an input image (`image`/`image_b64`/`input_image_b64`) — pass a
  workspace path to animate an existing image.
- Long-running. Keep `duration` short (2–5 s) while iterating.

### Music
- Core: `caption`/`style_prompt` (description), `lyrics` (use `[Instrumental]` for no vocals),
  `duration`, `model` variant, `seed`.

### Speech
- Core: `text` (required), `voice`, `speed`. Some models use `speaker` and `max_duration_ms`.

## Response handling (automatic)

The server saves the asset for you; this explains what it does so results are predictable:

- Most media cords return **raw bytes** with the real `Content-Type` (`image/jpeg`, `video/mp4`,
  `audio/wav`, `audio/mpeg`). The file extension is derived from that content type — **not** from the
  schema's declared `output_content_type`, which is sometimes inaccurate.
- Some cords return **JSON** carrying a `url` (downloaded automatically), a `data:` URI, or a base64
  string (decoded automatically).

## Cord selection

- With no `cord`, the server picks the primary generation cord for the kind (`generate`,
  `text2image`, `text2video`, `speak`, …) and never auto-selects an edit cord.
- Pass `cord` (by name or path) to target a specific operation. If the name is wrong, the error lists
  the available cords.

## Output location

- Default: `./assets/chutes/<kind>/` relative to the working directory (the project root).
- Override per call with `output_dir` and `filename`. Filenames default to `<model>-<timestamp>.<ext>`.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `401 Unauthorized` | Wrong auth scheme or missing key | Ensure `CHUTES_API_KEY` is set. Default sends the key raw; set `CHUTES_AUTH_SCHEME=bearer` to try the `Bearer` prefix. |
| `Invalid params … missing required field` | Payload doesn't match the schema | Re-read `describe_media_model` and fix the named fields; keep the payload flat. |
| `422 Invalid request` | Server-side payload rejection | Compare against the cord `example`; remove unexpected fields. |
| `503 No instances available` after retries | Model scaled to zero with no capacity | Choose another model of the same kind via `list_media_models`. |
| JSON "without a recognisable asset" | Unusual response shape | Inspect `describe_media_model`; the cord may return a field name the server doesn't recognize — report it. |

## Configuration (environment)

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHUTES_API_KEY` | — (required) | Chutes API key. |
| `CHUTES_AUTH_SCHEME` | `raw` | `raw` sends the key as-is; `bearer` prefixes `Bearer `. |
| `CHUTES_OUTPUT_DIR` | `assets/chutes` | Base output dir (a `<kind>/` subfolder is appended). |
| `CHUTES_WARMUP` | `true` | Warm models before invoking. |
| `CHUTES_COLD_START_RETRIES` | `4` | Retries on cold-start `503` (0 disables). |
| `CHUTES_COLD_START_BACKOFF_MS` | `8000` | Base backoff between retries (grows per attempt). |
| `CHUTES_PROGRESS_INTERVAL_MS` | `5000` | Progress heartbeat interval. |

## Worked example: generate then edit

1. `describe_media_model { model: "owner/qwen-image" }` → flat image schema.
2. `generate_media { model: "owner/qwen-image", kind: "image", params: { prompt: "a cozy reading nook by a rainy window", width: 768, height: 768, num_inference_steps: 12 } }` → saves `./assets/chutes/image/qwen-image-<ts>.jpg`.
3. `describe_media_model { model: "owner/qwen-image-edit" }` → requires `prompt` + `image_b64s`.
4. `generate_media { model: "owner/qwen-image-edit", kind: "image", params: { prompt: "make it a snowy winter night", image_b64s: ["assets/chutes/image/qwen-image-<ts>.jpg"] } }` → the saved image is encoded and edited; result saved under `./assets/chutes/image/`.
5. Reference the chosen file from the project (e.g. `<img src="assets/chutes/image/...">`).
