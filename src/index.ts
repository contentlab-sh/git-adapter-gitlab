import { GitRepositoryOptions } from 'contentlab-git-adapter'

export { GitLabAdapterModule } from './git-lab-adapter.module'
export { GitLabAdapterService } from './git-lab-adapter.service'

export interface GitLabRepositoryOptions extends GitRepositoryOptions {
  projectPath: string
  token: string
}
