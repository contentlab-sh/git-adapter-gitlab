# Introduction

**[Contentlab](https://contentlab.sh) is a library that generates a fully functional CRUD GraphQL API for structured
text data exclusively from files in a Git repository.**

This repository holds code that implements access to Git repositories hosted on GitLab (SaaS).

# Usage

Instantiate the adapter with `createAdapter()` and then call `setRepositoryOptions()` with `GitLabRepositoryOptions` on
the instance. These options are as follows:

| Option name   | Description                                     |
|---------------|-------------------------------------------------|
| `projectPath` | GitLab (SaaS) project path, e.g. `myorg/myrepo` |
| `token`       | GitLab (SaaS) personal access token             |

# License

The code in this repository is licensed under the permissive ISC license (see [LICENSE](LICENSE)).
