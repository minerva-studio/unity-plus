If any code change is made, commit, rebuild, and install after the task. If other changes were made during the task, do not disgard the unrelated changes. Only commit the code for this task.

C# symbols, types, methods, fields, references, rename edits, and type hierarchy must come from the C# server / VS Code C# providers. Do not add source-text C# parser fallbacks, fallback dependencies for C# semantics, or tests that preserve fallback C# parser behavior. If the C# provider cannot supply semantic data, fail clearly or use the provider's real empty result.
