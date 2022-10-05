import { Module } from '@nestjs/common'
import { GitLabAdapterService } from './git-lab-adapter.service'
import { GraphqlQueryFactoryService } from './graphql-query-factory.service'
import { ContentEntriesToActionsConverterService } from './content-entries-to-actions-converter.service'
import { HttpModule } from '@nestjs/axios'

@Module({
  imports: [HttpModule],
  providers: [
    GitLabAdapterService,
    GraphqlQueryFactoryService,
    ContentEntriesToActionsConverterService,
  ],
  exports: [GitLabAdapterService],
})
export class GitLabAdapterModule {}
