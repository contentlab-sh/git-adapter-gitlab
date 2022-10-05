import { Injectable, NotFoundException } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { GraphqlQueryFactoryService } from './graphql-query-factory.service'
import {
  CommitDraft,
  ENTRY_EXTENSION,
  ENTRY_FOLDER_NAME,
  SCHEMA_FILENAME,
  SCHEMA_FOLDER_NAME,
} from 'contentlab-git-adapter'
import { firstValueFrom } from 'rxjs'
import { Commit } from 'contentlab-git-adapter'
import { ContentEntriesToActionsConverterService } from './content-entries-to-actions-converter.service'
import { ActionModel } from './action.model'
import { GitAdapter } from 'contentlab-git-adapter'
import { map } from 'rxjs/operators'
import { parse } from 'yaml'
import { ISetupCache, setupCache } from 'axios-cache-adapter'
import { ContentEntry } from 'contentlab-git-adapter'
import { GitLabRepositoryOptions } from './index'

@Injectable()
export class GitLabAdapterService implements GitAdapter {
  static readonly QUERY_CACHE_SECONDS = 10 * 60

  private readonly axiosCache: ISetupCache

  private gitRepositoryOptions: GitLabRepositoryOptions | undefined

  constructor(
    private httpService: HttpService,
    private graphqlQueryFactory: GraphqlQueryFactoryService,
    private contentEntryToActionConverterService: ContentEntriesToActionsConverterService,
  ) {
    this.axiosCache = setupCache({
      maxAge: GitLabAdapterService.QUERY_CACHE_SECONDS * 1000, // milliseconds
      exclude: {
        methods: [], // HTTP methods not to cache
      },
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
    const allFilePaths: string[] = await firstValueFrom(
      this.httpService
        .post(
          'https://gitlab.com/api/graphql',
          {
            query: queryBlobs,
          },
          this.getAxiosConfig(token),
        )
        .pipe(
          map(
            (response) =>
              response.data.data.project.repository.tree.blobs.nodes,
          ),
        )
        .pipe(map((blobs) => blobs.map((blob: any) => blob.path))),
    )

    const entryFilePaths = allFilePaths.filter((filename: string) =>
      filename.endsWith(ENTRY_EXTENSION),
    )

    const queryContent = this.graphqlQueryFactory.createBlobContentQuery(
      projectPath,
      ref,
      entryFilePaths,
    )
    const content = await firstValueFrom(
      this.httpService
        .post(
          'https://gitlab.com/api/graphql',
          {
            query: queryContent,
          },
          this.getAxiosConfig(token),
        )
        .pipe(
          map((response) => response.data.data.project.repository.blobs.edges),
        ),
    )

    const extensionLength = ENTRY_EXTENSION.length
    return content
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
    const response = await firstValueFrom(
      this.httpService
        .post(
          'https://gitlab.com/api/graphql',
          {
            query: queryContent,
          },
          this.getAxiosConfig(token),
        )
        .pipe(
          map((response) => response.data.data.project.repository.blobs.edges),
        ),
    )

    if (response.length === 0) {
      throw new NotFoundException(
        `"${schemaFilePath}" not found in Git repository "${projectPath}" in branch "${ref}"`,
      )
    }

    return response[0].node.rawBlob
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

    const response = await firstValueFrom(
      this.httpService.post(
        'https://gitlab.com/api/graphql',
        {
          query: queryLatestCommit,
        },
        {
          // must not use cache adapter here, so we always get the branch's current head
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      ),
    )

    const lastCommit = response.data.data.project.repository.tree.lastCommit
    if (!lastCommit) {
      throw new NotFoundException(`No commit found for branch "${ref}"`)
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
      this.contentEntryToActionConverterService.convert(
        commitDraft.contentEntries,
        existingIdMap,
        commitDraft.parentSha,
      )

    const mutateCommit = this.graphqlQueryFactory.createCommitMutation()
    const response: any = await firstValueFrom(
      this.httpService.post(
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
      ),
    )

    const mutationResult = response.data.data.commitCreate

    if (mutationResult.errors.length > 0) {
      throw new Error(mutationResult.errors)
    }

    return new Commit(mutationResult.commit.sha)
  }

  // see https://github.com/nuxt-community/axios-module/issues/576 regarding return type
  private getAxiosConfig(repositoryToken: string): any {
    return {
      adapter: this.axiosCache.adapter,
      headers: {
        authorization: `Bearer ${repositoryToken}`,
      },
    }
  }
}
