import { GitAdapter, GitRepositoryOptions } from 'contentlab-git-adapter'
import { app } from './container'

export { GitLabAdapterService } from './git-lab-adapter.service'

export interface GitLabRepositoryOptions extends GitRepositoryOptions {
  projectPath: string
  token: string
}

export function createAdapter(): GitAdapter {
  return app.adapter
}
