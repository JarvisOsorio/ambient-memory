# Publishing ambient-memory to npm

This environment cannot authenticate to npm. Jarvis (package owner) should:

```bash
git clone https://github.com/JarvisOsorio/ambient-memory.git
cd ambient-memory
# merge/checkout the v0.3.0 PR branch first
npm ci
npm test
npm login
npm publish --access public
npm view ambient-memory version   # → 0.3.0
```

Then verify:

```bash
npx -y ambient-memory@0.3.0 --help
npx -y ambient-memory doctor
```

GitHub release tag (optional): create `v0.3.0` pointing at the merge commit on `main`.
