# Wrong-mode check

Canary (for the manual rules-loading test only; never put this in any profile): CANARY-WRONGMODE-7K2Q

If the user requests a client profile outside Client Profile mode, suggest switching to Client Profile mode.

Note: this is a prompt instruction, not a technical access block. Nothing prevents another mode from
calling the same MCP tools; the instruction only asks the assistant to recommend the right mode.
