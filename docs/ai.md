# AI quick actions

Knotebook ships four built-in AI quick actions — rewrite, translate, summarize, continue — that run against a provider you configure yourself; there's no bundled AI vendor and nothing is sent anywhere until an admin sets one up.

**Setup (admin only):** open **Settings → AI** (linked from the user menu). Configuration is three layers, in order:

1. **Providers** — an upstream AI API. Two types:
   - `anthropic` — talks to the Anthropic Messages API. `baseUrl` is the API **origin**, e.g. `https://api.anthropic.com` (no `/v1` suffix — Knotebook appends the versioned path itself).
   - `openai_compatible` — talks to any OpenAI-compatible chat-completions API (OpenAI itself, a local/on-prem [Ollama](https://ollama.com) instance, vLLM, etc.). `baseUrl` **includes** the `/v1` suffix, e.g. `http://<host>:11434/v1` for Ollama. The API key is optional here — leave it blank for an unauthenticated local server.
   - Use the **Test** button after saving a provider to confirm Knotebook can reach it with the stored key before relying on it.
2. **Models** — a specific model ID under one of your providers (e.g. `claude-sonnet-4-5` or `llama3.1`), marked available for chat. One chat model across all providers can be flagged as the default; quick actions that aren't bound to a specific model fall back to it.
3. **Actions** — the four built-in ones (rename or disable them freely, but they can't be deleted — see [Known limitations](./known-limitations.md)), plus any custom actions you add with your own system prompt and a user-message template containing the literal placeholder `{{text}}` (the selected text is substituted in verbatim, special-character-safe).

An action with no model configured for it, and no provider default to fall back to, simply doesn't appear in the editor — "not configured" fails closed and silently, not with an error.

**API keys are encrypted at rest** with a key derived from `APP_SECRET` (AES-256-GCM; the ciphertext, IV, auth tag, a non-secret key fingerprint (used to detect a stale `APP_SECRET` before attempting to decrypt), and a format version number are the only things stored). The ciphertext is never serialized into any API response — admin endpoints (provider list, create, update) select a column set that excludes it, returning only a derived `hasKey` boolean instead. **Rotating `APP_SECRET` invalidates every stored provider key** — Knotebook can no longer decrypt them, providers show as degraded in the Settings UI, and you'll need to re-enter each provider's API key (which re-encrypts it under the new secret) before quick actions using it work again.

  **Changing a provider's Base URL clears its stored key.** The key is sent to whatever host that field names — that is what a provider *is* — so a key entered for one host does not silently follow the provider to another. Change the URL and the provider shows as having no key until you enter one again; supply the new key in the same edit and nothing is cleared. The Settings UI says so before you save. This is a deliberate trade-off for a product that otherwise promises a stored key can never be read back: without it, any admin could point a provider at a host they control, trigger one request, and receive the plaintext key. It does not make an untrusted admin safe — see [Known limitations](./known-limitations.md).

  The ciphertext is bound to the provider row it belongs to: the provider's id is authenticated as part of the encryption, so a stored key only decrypts under the provider it was entered for. Moving an `api_key_encrypted` value to a different provider row — restoring one row from an older backup into a provider that was deleted and recreated, for instance — no longer works; that provider shows as degraded and the fix is to enter the API key again.

  Keys stored before this binding existed are upgraded automatically: on each start the server rewrites any old-format ciphertext it can still decrypt, logging how many it converted and how many remain. Nothing is rewritten unless it decrypts cleanly, and a failed rewrite is logged and retried on the next start without affecting AI features. **The upgrade is one-way**: once a key has been rewritten, rolling the application back to a version older than 0.2 leaves it unreadable, and those providers have to have their keys entered again.

**Using it:** select text in the block editor and pick an action from the floating toolbar, or open the action list in the right-hand AI panel to run one over the whole note. The response streams in live. Each action is configured as either "direct" (built-in Rewrite/Translate: applies automatically as the response finishes) or "preview" (built-in Summarize/Continue writing: shows the result and waits for you to accept or discard it) — either way you can cancel mid-stream, and an applied direct action can still be reverted afterward. If the model's own extended-thinking/reasoning output is available upstream, it's filtered out server-side and never reaches the browser — only the final answer streams to the client.

See [API contract summary](./api.md) for the underlying `/api/admin/ai/*` and `/api/ai*` endpoints.
