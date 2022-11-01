import { GraphqlQueryFactoryService } from './graphql-query-factory.service'
import {
  Commit,
  CommitDraft,
  ContentEntry,
  ENTRY_EXTENSION,
  ENTRY_FOLDER_NAME,
  GitAdapter,
  SCHEMA_FILENAME,
  SCHEMA_FOLDER_NAME,
} from '@contentlab/git-adapter'
import { ContentEntriesToActionsConverterService } from './content-entries-to-actions-converter.service'
import { ActionModel } from './action.model'
import { parse } from 'yaml'
import { AxiosCacheInstance, setupCache } from 'axios-cache-interceptor'
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

  public async setRepositoryOptions(
    repositoryOptions: GitLabRepositoryOptions,
  ): Promise<void> {
    this.gitRepositoryOptions = repositoryOptions
  }

  public async getContentEntries(commitHash: string): Promise<ContentEntry[]> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before reading')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token

    const queryBlobs = this.graphqlQueryFactory.createBlobQuery(
      projectPath,
      commitHash,
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
      commitHash,
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

  public async getSchema(commitHash: string): Promise<string> {
    if (this.gitRepositoryOptions === undefined) {
      throw new Error('Repository options must be set before reading')
    }

    const projectPath = this.gitRepositoryOptions.projectPath
    const token = this.gitRepositoryOptions.token
    const schemaFilePath = `${SCHEMA_FOLDER_NAME}/${SCHEMA_FILENAME}`

    const queryContent = this.graphqlQueryFactory.createBlobContentQuery(
      projectPath,
      commitHash,
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
        `"${schemaFilePath}" not found in Git repository "${projectPath}" at commit "${commitHash}"`,
      )
    }

    return edges[0].node.rawBlob
  }

  public async getLatestCommitHash(ref: string): Promise<string> {
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
