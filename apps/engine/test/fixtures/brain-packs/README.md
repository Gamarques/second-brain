# Brain Pack fixtures

`valid-multilingual.json` is the source of a small, valid version 1 pack: two
collections, four documents in English, Brazilian Portuguese and Spanish with
non-Latin characters, an internal reference, and one document exported in the
`reconstructed` representation. Tests encode it with the codec to obtain the
archive bytes, then tamper with those bytes to produce the malformed cases
(hash mismatch, duplicate keys, invalid references, unsafe paths, oversized
entries), so no opaque binary archive is committed.
