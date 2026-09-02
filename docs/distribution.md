# Distribution & Discoverability Checklist

This document is for maintainers of `dsh-ssh-files-sidebar`. It keeps repository discoverability, installation, releases, and ecosystem distribution from becoming an afterthought.

## 1. GitHub repository metadata

DeepSeek Harness explicitly recommends adding the `dsh-plugin` topic to plugin repositories so they can be discovered by the ecosystem.

Recommended GitHub **Description**:

```text
Remote SSH workspace & deployment Agent for DeepSeek Harness — SSH Files, terminal, remote editing, zero-to-one Bootstrap, Runbook and closed-loop deployment.
```

Recommended **Topics**:

```text
dsh-plugin
deepseek-harness
dsh
remote-ssh
ssh
sftp
remote-development
remote-workspace
devops
deployment
deployment-automation
agentic-ai
typescript
```

After repository settings change, verify the public repository API actually shows the new description and non-empty topics.

## 2. Installation ladder

The project should keep three install paths, in this order:

1. **Prebuilt GitHub Release tarball** — recommended for normal users, no local build.
2. **npm package** — preferred long-term if/when registry publishing is enabled.
3. **GitHub source / local link** — development and debugging only.

The README must keep the easiest prebuilt install above architecture and design details.

## 3. Automated GitHub Releases

`.github/workflows/release.yml` creates a release whenever `package.json` has a version that does not already have a `v<version>` release.

The release contains:

```text
dsh-ssh-files-sidebar.tgz
SHA256SUMS.txt
```

The stable install URL is therefore:

```text
https://github.com/qigelunbiya/dsh-ssh-files-sidebar/releases/latest/download/dsh-ssh-files-sidebar.tgz
```

Every distributable code change should bump `package.json` before merging to `main`. Documentation-only changes do not require a version bump.

## 4. npm readiness

`package.json` includes repository metadata, keywords, `prepare`, `prepack`, and public publish configuration.

Before the first npm publish:

1. confirm the package name is available;
2. enable npm 2FA;
3. prefer npm Trusted Publishing / provenance when practical;
4. run `pnpm pack` and inspect the tarball;
5. publish only after CI passes.

Once npm publishing is active, move the npm command to the first install option:

```text
dsh plugin --profile web add dsh-ssh-files-sidebar
```

## 5. README conversion checklist

The first screen should answer, in this order:

1. What is this?
2. What does it look / feel like?
3. What makes it different from a basic SSH plugin?
4. How do I install it in one command?
5. What can I do after installing it?

Keep detailed deployment theory and architecture below the quick install.

### Real product screenshot / GIF

`docs/assets/hero.svg` is a product overview graphic, not a fake screenshot.

For better conversion, record a real 10–25 second GIF or short MP4 showing:

1. opening SSH Files;
2. browsing a remote directory;
3. opening/editing a file;
4. terminal or Linked SSH in the same conversation;
5. a short deployment / verification interaction.

When a real demo is available, place it directly below the hero headline and above the installation command. Do not use mock UI and label it as a screenshot.

## 6. DSH ecosystem distribution

After the `dsh-plugin` topic is present and the release install works:

- verify the repository appears in GitHub's `dsh-plugin` topic;
- verify community plugin indexes can detect it;
- submit it to curated DSH / awesome lists where manual submission is supported;
- share a short demo in DeepSeek Harness Discussions / Discord / relevant Chinese communities.

A good announcement should lead with the user problem and a demo, not with internal architecture.

Suggested title:

```text
DSH Remote Workspace & Deployment Agent: SSH Files + Remote Workspace + zero-to-one deployment + closed-loop release
```

## 7. Release QA

Before announcing a release:

- CI green;
- release tarball exists;
- tarball contains `lib/index.js`, `lib/client.js`, `cordis.patch.yml`, README, LICENSE and NOTICE;
- stable `releases/latest/download/...` URL works;
- clean-profile installation is tested;
- only one top-level `dsh-ssh-files-sidebar` row is required;
- README Chinese / English installation commands match;
- version badge and release badge resolve.

## 8. Search language

Keep these phrases present naturally across the repository description, README, package keywords, and release notes:

```text
DeepSeek Harness
DSH plugin
Remote SSH
SSH Files
SFTP
Remote Workspace
remote development
deployment agent
deployment automation
Runbook
zero-to-one deployment
closed-loop deployment
```

Avoid keyword stuffing; the first paragraph should still read like a product description.
