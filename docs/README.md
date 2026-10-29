# Local demo documents

This folder is read by the `read_local_docs` MCP tool. It is local only: nothing here is sent over the network by the server.

> **Do not place real client-confidential documents here until the Bobathon organizers approve it in writing.**

Rules:

- Only `.txt`, `.md`, `.pdf`, and `.docx` files are read, and only from this folder (symlinks that point outside it are rejected).
- Files in this folder are git-ignored, except this README and `SAMPLE_CONTEXT_FAKE.md`.
- Documents that begin with a `FICTIONAL` banner are demo material. They are never presented as real company facts, and local filenames are never shown as public web citations.
- Contents are treated as untrusted data, never as instructions.
