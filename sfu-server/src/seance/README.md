<!-- //// Neoffice — added file (no upstream equivalent) -->
# Séance note-taking

An opt-in module of the SFU. When a host starts a *séance* and a participant
agrees, the SFU keeps that participant's voice as a continuous Ogg/Opus track,
**sealed for the instance** that owns the séance, until the instance picks it up.

Nothing happens unless a client sends a `seance:*` event. `SEANCE_TAP=0`
switches the module off (events answer `seance_unavailable`, `/seance/*`
answers 404, `/health` stops announcing `features.seance`).

## Trust model

* The instances sign two short-lived tokens with the secret they already share
  with the SFU (`JWT_SECRET`). **No existing token or secret is changed.**
  The new tokens cannot be taken for a connection token, nor the other way round:
  `aud = neoffice-seance`, `scope = seance`, JOSE header `typ` =
  `neoffice-seance-start+jwt` or `neoffice-seance-consent+jwt`, lifetime
  ≤ 5 minutes, single use (`jti`).
* **Nothing is captured before the person agrees.** The consent token is bound
  to one person (the socket's user), one séance, one room.
* **The SFU cannot read what it stores.** Each chunk is sealed with a fresh
  AES-256-GCM key, wrapped with the séance's RSA public key
  (RSA-OAEP / SHA-256) that the instance puts in the start token.
* **Pick-up is protected by a per-séance pull key** the instance generates;
  the SFU stores only its SHA-256.
* End-to-end encrypted rooms are refused (`e2ee_required` claim).

## Tokens (HS256)

Start token (`typ: neoffice-seance-start+jwt`):

| claim | meaning |
|---|---|
| `aud` | `neoffice-seance` |
| `scope` | `seance` |
| `tenant` | the connection token's tenant ('' / absent when single-tenant) |
| `meeting_id` | the room, as in the connection token |
| `seance_id` | the instance's identifier of the séance (any string ≤ 256) |
| `host_user_id` | must equal the socket's user, who must be host or co-host |
| `pull_key_hash` | hex SHA-256 of the pull key |
| `enc_key` | PEM RSA public key, ≥ 2048 bits (omitted only with `SEANCE_ALLOW_PLAINTEXT=1`) |
| `jti`, `iat`, `exp` | `exp - iat ≤ 300` |

Consent token (`typ: neoffice-seance-consent+jwt`): same `aud`, `scope`,
`tenant`, `meeting_id`, `seance_id`, plus `user_id` (the person), `consent_at`
(ISO 8601, the instance's record), `jti`, `iat`, `exp`.

## Socket events

Every event is acknowledged with `{ success: true, ...view }` or
`{ success: false, error: <code> }`.

| event | who | payload |
|---|---|---|
| `seance:start` | host / co-host | `{ token }` |
| `seance:consent` | the person | `{ token }` |
| `seance:decline` | the person | `{}` |
| `seance:withdraw` | the person | `{ erase?: boolean }` |
| `seance:stop` | host / co-host / starter | `{}` |
| `seance:get_state` | anyone in the room | `{}` |

Pushed to the room: `seance:state` `{ active, seance_id, started_at, started_by,
capturing: [user ids] }` and `seance:ended` `{ seance_id, reason }`.

Error codes: `seance_unavailable`, `not_allowed`, `not_in_room`, `not_host`,
`e2ee_room`, `token_invalid`, `wrong_room`, `wrong_user`, `wrong_seance`,
`replayed`, `already_active`, `seance_exists`, `no_active_seance`, `key_required`,
`key_invalid`, `capacity`, `spool_unavailable`, `rate_limited`, `internal_error`.

## Pick-up (HTTP, server to server)

`handle` = first 32 hex characters of `sha256("<tenant>\n<seance_id>")`.
Every request carries `Authorization: Bearer <pull key>`.

| request | answer |
|---|---|
| `GET /seance/<handle>/manifest` | tracks (person, consent, offset, speech intervals, chunks with SHA-256) |
| `GET /seance/<handle>/chunks/<file>` | one sealed chunk |
| `POST /seance/<handle>/ack` `{ files }` | the chunks the instance stored: removed |
| `POST /seance/<handle>/stop` | ends the séance |
| `POST /seance/<handle>/withdraw` `{ user_id, erase }` | a person withdrew elsewhere |
| `DELETE /seance/<handle>` | forgets everything |

## Sealed chunk format

```
"NSC1" | wrapped key length (u16 BE) | RSA-OAEP(SHA-256) wrapped AES key | IV (12) | ciphertext | GCM tag (16)
```

Additional authenticated data: `<seance_id>/<track_id>/<chunk index>`.
Decrypted chunks are whole Ogg pages: **concatenated in index order they are one
valid Ogg/Opus stream** (mono, 48 kHz). The stream is continuous in time:
holes (muted microphone, DTX, lost packets) are filled with silence, so the
position in the stream is the time since the track's `start_offset_ms`.

## Files

```
<spool>/<handle>/seance.json
<spool>/<handle>/<track>.json
<spool>/<handle>/<track>-<index>-<start ms>-<duration ms>[-f].nsc
```

The manifest can be rebuilt from the directory, so a restart of the SFU loses
only the chunk being written.

## Tests

`yarn test` (Node's built-in runner, ffmpeg needed for the audio checks, which
are skipped without it). `node scripts/seance-smoke.js` plays the same flow
against a running SFU started with `NODE_ENV=development`.
