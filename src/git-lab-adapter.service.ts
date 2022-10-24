import { GraphqlQueryFactoryService } from './graphql-query-factory.service'
import {
  CommitDraft,
  ENTRY_EXTENSION,
  ENTRY_FOLDER_NAME,
  SCHEMA_FILENAME,
  SCHEMA_FOLDER_NAME,
} from 'contentlab-git-adapter'
import { Commit } from 'contentlab-git-adapter'
import { ContentEntriesToActionsConverterService } from './content-entries-to-actions-converter.service'
import { ActionModel } from './action.model'
import { GitAdapter } from 'contentlab-git-adapter'
import { parse } from 'yaml'
import { AxiosCacheInstance, setupCache } from 'axios-cache-interceptor'
import { ContentEntry } from 'contentlab-git-adapter'
import { GitLabRepositoryOptions } from './index'
import { AxiosInstance } from 'axios'

export class GitLabAdapterService implements GitAdapter {
  static readonly QUERY_CACHE_SECONDS = 10 * 60

  private readonly cachedHttpAdapter: AxiosCacheInstance

  private gitRepositoryOptions: GitLabRepositoryOptions | undefined

  constructor(
    private httpAdapter: AxiosInstance,
    private graphqlQueryFactory: GraphqlQueryFactoryService,
    private contentEntriesToActionsConverter: ContentEntriesToActionsConverterService,
  ) {
    this.cachedHttpAdapter = setupCache(httpAdapter, {
      ttl: GitLabAdapterService.QUERY_CACHE_SECONDS * 1000, // milliseconds
      methods: ['get', 'post'],
    })
  }

  public setRepositoryOptions(repositoryOptions: GitLabRepositoryOptions) {
    this.gitRepositoryOptions = repositoryOptions
  }

  public async getContentEntries(ref: string): Promise<ContentEntry[]> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before reading')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token

    const queryBlobs = this.graphqlQueryFactory.createBlobQuery(
      projectPath,
      ref,
      ENTRY_FOLDER_NAME,
    )
    const filesResponse = await this.cachedHttpAdapter.post(
      'https://gitlab.com/api/graphql',
      {
        query: queryBlobs,
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )
    const allFilePaths: string[] =
      filesResponse.data.data.project.repository.tree.blobs.nodes.map(
        (blob: any) => blob.path,
      )

    const entryFilePaths = allFilePaths.filter((filename: string) =>
      filename.endsWith(ENTRY_EXTENSION),
    )

    const queryContent = this.graphqlQueryFactory.createBlobContentQuery(
      projectPath,
      ref,
      entryFilePaths,
    )
    const contentResponse = await this.cachedHttpAdapter.post(
      'https://gitlab.com/api/graphql',
      {
        query: queryContent,
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )
    const edges = contentResponse.data.data.project.repository.blobs.edges

    const extensionLength = ENTRY_EXTENSION.length
    return edges
      .map((edge: any) => edge.node)
      .map((node: any) => {
        const content = parse(node.rawBlob)
        const id = node.path.substring(
          ENTRY_FOLDER_NAME.length + 1, // trailing slash folder separator
          node.path.length - extensionLength,
        )
        return new ContentEntry(id, content.metadata, content.data)
      })
  }

  public async getSchema(ref: string): Promise<string> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before reading')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token
    const schemaFilePath = `${SCHEMA_FOLDER_NAME}/${SCHEMA_FILENAME}`

    const queryContent = this.graphqlQueryFactory.createBlobContentQuery(
      projectPath,
      ref,
      [schemaFilePath],
    )
    const response = await this.cachedHttpAdapter.post(
      'https://gitlab.com/api/graphql',
      {
        query: queryContent,
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )
    const edges = response.data.data.project.repository.blobs.edges

    if (edges.length === 0) {
      throw new Error(
        `"${schemaFilePath}" not found in Git repository "${projectPath}" in branch "${ref}"`,
      )
    }

    return edges[0].node.rawBlob
  }

  public async getLatestCommitSha(ref: string): Promise<string> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before reading')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token

    const queryLatestCommit = this.graphqlQueryFactory.createLatestCommitQuery(
      projectPath,
      ref,
    )

    // must not use cache adapter here, so we always get the branch's current head
    const response = await this.httpAdapter.post(
      'https://gitlab.com/api/graphql',
      {
        query: queryLatestCommit,
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )

    const lastCommit = response.data.data.project.repository.tree.lastCommit
    if (!lastCommit) {
      throw new Error(`No commit found for branch "${ref}"`)
    }

    return lastCommit.sha
  }

  public async createCommit(commitDraft: CommitDraft): Promise<Commit> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before committing')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token

    // assumes branch/ref already exists
    const existingContentEntries = await this.getContentEntries(commitDraft.ref)
    const existingIdMap = new Map<string, boolean>()
    existingContentEntries.forEach((entry) => existingIdMap.set(entry.id, true))

    const actions: ActionModel[] =
      this.contentEntriesToActionsConverter.convert(
        commitDraft.contentEntries,
        existingIdMap,
        commitDraft.parentSha,
      )

    const mutateCommit = this.graphqlQueryFactory.createCommitMutation()
    const response: any = await this.httpAdapter.post(
      'https://gitlab.com/api/graphql',
      {
        query: mutateCommit,
        variables: {
          actions,
          branch: commitDraft.ref, // if `ref` is a hash and not a branch, commits are rejected by GitLab
          message: commitDraft.message ?? '-',
          projectPath: projectPath,
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )

    const mutationResult = response.data.data.commitCreate

    if (mutationResult.errors.length > 0) {
      throw new Error(mutationResult.errors)
    }

    return new Commit(mutationResult.commit.sha)
  }
}
