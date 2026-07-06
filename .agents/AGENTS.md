If any file change is made, commit and Rebuild the plugin after each task. Do not include any unrelated files and do not discard them.

C# symbols, types, methods, fields, references, rename edits, and type hierarchy must come from the C# server / VS Code C# providers. Do not add source-text C# parser fallbacks, fallback dependencies for C# semantics, or tests that preserve fallback C# parser behavior. If the C# provider cannot supply semantic data, fail clearly or use the provider's real empty result.
