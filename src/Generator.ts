import * as changeCase from 'change-case'
import dayjs from 'dayjs'
import fs from 'fs-extra'
import got from 'got'
import path from 'path'
import prettier from 'prettier'
import {
  castArray,
  cloneDeepFast,
  dedent,
  groupBy,
  isEmpty,
  isFunction,
  memoize,
  noop,
  omit,
  uniq,
  values,
} from 'vtils'
import {
  CategoryList,
  CommentConfig,
  Config,
  ExtendedInterface,
  Interface,
  InterfaceList,
  Method,
  Project,
  ProjectConfig,
  RequestBodyType,
  ServerConfig,
  SyntheticalConfig,
} from './types'
import { exec } from 'child_process'
import {
  getNormalizedRelativePath,
  getRequestDataJsonSchema,
  getResponseDataJsonSchema,
  jsonSchemaToType,
  throwError,
} from './utils'
import { SwaggerToYApiServer } from './SwaggerToYApiServer'

interface OutputFileList {
  [outputFilePath: string]: {
    syntheticalConfig: SyntheticalConfig
    content: string[]
    requestFunctionFilePath: string
    requestHookMakerFilePath: string
  }
}

export class Generator {
  /** 配置 */
  private config: ServerConfig[] = []

  private disposes: Array<() => any> = []

  constructor(
    config: Config,
    private options: { cwd: string } = { cwd: process.cwd() },
  ) {
    // config 可能是对象或数组，统一为数组
    this.config = castArray(config)
  }

  async prepare(): Promise<void> {
    this.config = await Promise.all(
      // config 可能是对象或数组，统一为数组
      this.config.map(async item => {
        if (item.serverType === 'swagger') {
          const swaggerToYApiServer = new SwaggerToYApiServer({
            swaggerJsonUrl: item.serverUrl,
          })
          item.serverUrl = await swaggerToYApiServer.start()
          this.disposes.push(() => swaggerToYApiServer.stop())
        }
        if (item.serverUrl) {
          // 去除地址后面的 /
          // fix: https://github.com/fjc0k/yapi-to-typescript/issues/22
          item.serverUrl = item.serverUrl.replace(/\/+$/, '')
        }
        return item
      }),
    )
  }

  async generate(): Promise<OutputFileList> {
    const outputFileList: OutputFileList = Object.create(null)

    await Promise.all(
      this.config.map(async (serverConfig, serverIndex) => {
        const projects = serverConfig.projects.reduce<ProjectConfig[]>(
          (projects, project) => {
            projects.push(
              ...castArray(project.token).map(token => ({
                ...project,
                token: token,
              })),
            )
            return projects
          },
          [],
        )
        return Promise.all(
          projects.map(async (projectConfig, projectIndex) => {
            const projectInfo = await this.fetchProjectInfo({
              ...serverConfig,
              ...projectConfig,
            })
            await Promise.all(
              projectConfig.categories.map(
                async (categoryConfig, categoryIndex) => {
                  // 分类处理
                  // 数组化
                  let categoryIds = castArray(categoryConfig.id)
                  // 全部分类
                  if (categoryIds.includes(0)) {
                    categoryIds.push(...projectInfo.cats.map(cat => cat._id))
                  }
                  // 唯一化
                  categoryIds = uniq(categoryIds)
                  // 去掉被排除的分类
                  const excludedCategoryIds = categoryIds
                    .filter(id => id < 0)
                    .map(Math.abs)
                  categoryIds = categoryIds.filter(
                    id => !excludedCategoryIds.includes(Math.abs(id)),
                  )
                  // 删除不存在的分类
                  categoryIds = categoryIds.filter(
                    id => !!projectInfo.cats.find(cat => cat._id === id),
                  )
                  // 顺序化
                  categoryIds = categoryIds.sort()

                  const codes = await Promise.all(
                    categoryIds.map<
                      Promise<{
                        outputFilePath: string
                        code: string
                        weights: number[]
                      }>
                    >(async (id, categoryIndex2) => {
                      categoryConfig = {
                        ...categoryConfig,
                        id: id,
                      }
                      const syntheticalConfig: SyntheticalConfig = {
                        ...serverConfig,
                        ...projectConfig,
                        ...categoryConfig,
                        mockUrl: projectInfo.getMockUrl(),
                      }
                      syntheticalConfig.target =
                        syntheticalConfig.target || 'typescript'
                      syntheticalConfig.devUrl = projectInfo.getDevUrl(
                        syntheticalConfig.devEnvName!,
                      )
                      syntheticalConfig.prodUrl = projectInfo.getProdUrl(
                        syntheticalConfig.prodEnvName!,
                      )
                      const interfaceList = (
                        await this.fetchInterfaceList(syntheticalConfig)
                      )
                        .map(interfaceInfo => {
                          // 实现 _project 字段
                          interfaceInfo._project = omit(projectInfo, [
                            'cats',
                            'getMockUrl',
                            'getDevUrl',
                            'getProdUrl',
                          ])
                          return interfaceInfo
                        })
                        .sort((a, b) => a._id - b._id)
                      const outputFilePath = path.resolve(
                        this.options.cwd,
                        syntheticalConfig.outputFilePath!,
                      )
                      const categoryUID = `_${serverIndex}_${projectIndex}_${categoryIndex}_${categoryIndex2}`
                      const categoryCode =
                        interfaceList.length === 0
                          ? ''
                          : [
                              syntheticalConfig.typesOnly
                                ? ''
                                : dedent`
                                  const mockUrl${categoryUID} = ${JSON.stringify(
                                    syntheticalConfig.mockUrl,
                                  )}
                              
                                  const dataKey${categoryUID} = ${JSON.stringify(
                                    syntheticalConfig.dataKey,
                                  )}
                                `,
                              ...(await Promise.all(
                                interfaceList
                                  .map(interfaceInfo => {
                                    const _interfaceInfo = isFunction(
                                      syntheticalConfig.preproccessInterface,
                                    )
                                      ? syntheticalConfig.preproccessInterface(
                                          cloneDeepFast(interfaceInfo),
                                          changeCase,
                                        )
                                      : interfaceInfo
                                    return _interfaceInfo
                                  })
                                  .filter(Boolean)
                                  .map((interfaceInfo: any) =>
                                    this.generateInterfaceCode(
                                      syntheticalConfig,
                                      interfaceInfo,
                                      categoryUID,
                                    ),
                                  ),
                              )),
                            ].join('\n\n')
                      if (!outputFileList[outputFilePath]) {
                        outputFileList[outputFilePath] = {
                          syntheticalConfig,
                          content: [],
                          requestFunctionFilePath: syntheticalConfig.requestFunctionFilePath
                            ? path.resolve(
                                this.options.cwd,
                                syntheticalConfig.requestFunctionFilePath,
                              )
                            : path.join(
                                path.dirname(outputFilePath),
                                'request.ts',
                              ),
                          requestHookMakerFilePath:
                            syntheticalConfig.reactHooks &&
                            syntheticalConfig.reactHooks.enabled
                              ? syntheticalConfig.reactHooks
                                  .requestHookMakerFilePath
                                ? path.resolve(
                                    this.options.cwd,
                                    syntheticalConfig.reactHooks
                                      .requestHookMakerFilePath,
                                  )
                                : path.join(
                                    path.dirname(outputFilePath),
                                    'makeRequestHook.ts',
                                  )
                              : '',
                        }
                      }
                      return {
                        outputFilePath: outputFilePath,
                        code: categoryCode,
                        weights: [
                          serverIndex,
                          projectIndex,
                          categoryIndex,
                          categoryIndex2,
                        ],
                      }
                    }),
                  )
                  for (const groupedCodes of values(
                    groupBy(codes, item => item.outputFilePath),
                  )) {
                    groupedCodes.sort((a, b) => {
                      const x = a.weights.length > b.weights.length ? b : a
                      const minLen = Math.min(
                        a.weights.length,
                        b.weights.length,
                      )
                      const maxLen = Math.max(
                        a.weights.length,
                        b.weights.length,
                      )
                      x.weights.push(...new Array(maxLen - minLen).fill(0))
                      const w = a.weights.reduce((w, _, i) => {
                        if (w === 0) {
                          w = a.weights[i] - b.weights[i]
                        }
                        return w
                      }, 0)
                      return w
                    })
                    outputFileList[groupedCodes[0].outputFilePath].content.push(
                      ...groupedCodes.map(item => item.code),
                    )
                  }
                },
              ),
            )
          }),
        )
      }),
    )

    return outputFileList
  }

  async write(outputFileList: OutputFileList) {
    return Promise.all(
      Object.keys(outputFileList).map(async outputFilePath => {
        let {
          // eslint-disable-next-line prefer-const
          content,
          requestFunctionFilePath,
          requestHookMakerFilePath,
          // eslint-disable-next-line prefer-const
          syntheticalConfig,
        } = outputFileList[outputFilePath]

        // const rawRequestFunctionFilePath = requestFunctionFilePath
        // const rawRequestHookMakerFilePath = requestHookMakerFilePath

        // 支持 .jsx? 后缀
        outputFilePath = outputFilePath.replace(/\.js(x)?$/, '.ts$1')
        requestFunctionFilePath = requestFunctionFilePath.replace(
          /\.js(x)?$/,
          '.ts$1',
        )
        requestHookMakerFilePath = requestHookMakerFilePath.replace(
          /\.js(x)?$/,
          '.ts$1',
        )

        if (!syntheticalConfig.typesOnly) {
          // if (!(await fs.pathExists(rawRequestFunctionFilePath))) {
          //   await fs.outputFile(
          //     requestFunctionFilePath,
          //     dedent`
          //     `,
          //   )
          // }
          // if (
          //   syntheticalConfig.reactHooks &&
          //   syntheticalConfig.reactHooks.enabled &&
          //   !(await fs.pathExists(rawRequestHookMakerFilePath))
          // ) {
          //   await fs.outputFile(
          //     requestHookMakerFilePath,
          //     dedent`
          //     `,
          //   )
          // }
        }

        // 始终写入主文件
        /* tslint:disable */
        /* eslint-disable */
        const rawOutputContent = dedent`
          ${
            syntheticalConfig.typesOnly
              ? content.join('\n\n').trim()
              : dedent`
              /* eslint-disable @typescript-eslint/no-explicit-any */
              /* eslint-disable @typescript-eslint/no-empty-interface */
              import { makeRequest } from './makeRequest';
              import { Method, RequestBodyType, ResponseBodyType } from './type';
              import type { RequestConfig, FileData } from './type';

                ${
                  !syntheticalConfig.reactHooks ||
                  !syntheticalConfig.reactHooks.enabled
                    ? ''
                    : dedent`
                      // @ts-ignore
                      import makeRequestHook from ${JSON.stringify(
                        getNormalizedRelativePath(
                          outputFilePath,
                          requestHookMakerFilePath,
                        ),
                      )}
                    `
                }

                ${content.join('\n\n').trim()}
              `
          }
        `
        // ref: https://prettier.io/docs/en/options.html
        const prettyOutputContent = prettier.format(rawOutputContent, {
          parser: 'typescript',
          printWidth: 120,
          tabWidth: 2,
          singleQuote: true,
          semi: false,
          trailingComma: 'all',
          bracketSpacing: false,
          endOfLine: 'lf',
        })
        /* prettier-ignore-start */
        /* prettier-ignore-end */
        const outputContent = `${dedent`
          
          ${prettyOutputContent}
        `}\n`
        await fs.outputFile(outputFilePath, outputContent)

        // 如果要生成 JavaScript 代码，
        // 则先对主文件进行 tsc 编译，主文件引用到的其他文件也会被编译，
        // 然后，删除原始的 .tsx? 文件。
        if (syntheticalConfig.target === 'javascript') {
          await this.tsc(outputFilePath)
          await Promise.all([
            fs.remove(requestFunctionFilePath).catch(noop),
            fs.remove(requestHookMakerFilePath).catch(noop),
            fs.remove(outputFilePath).catch(noop),
          ])
        }
      }),
    )
  }

  async tsc(file: string) {
    return new Promise<void>(resolve => {
      // add this to fix bug that not-generator-file-on-window
      const command = `${
        require('os').platform() === 'win32' ? 'node ' : ''
      }${require.resolve(`typescript/bin/tsc`)}`

      exec(
        `${command} --target ES2019 --module ESNext --jsx preserve --declaration --esModuleInterop ${file}`,
        {
          cwd: this.options.cwd,
          env: process.env,
        },
        () => resolve(),
      )
    })
  }

  async fetchApi<T = any>(url: string, query: Record<string, any>): Promise<T> {
    const { body: res } = await got.get<{
      errcode: any
      errmsg: any
      data: any
    }>(url, {
      searchParams: query,
      responseType: 'json',
      https: {
        rejectUnauthorized: false,
      },
    })
    /* istanbul ignore next */
    if (res && res.errcode) {
      throwError(res.errmsg)
    }
    return res.data || res
  }

  fetchProject = memoize(
    async ({ serverUrl, token }: SyntheticalConfig) => {
      const projectInfo = await this.fetchApi<Project>(
        `${serverUrl}/api/project/get`,
        {
          token: token!,
        },
      )
      const basePath = `/${projectInfo.basepath || '/'}`
        .replace(/\/+$/, '')
        .replace(/^\/+/, '/')
      projectInfo.basepath = basePath
      return projectInfo
    },
    ({ serverUrl, token }: SyntheticalConfig) => `${serverUrl}|${token}`,
  )

  fetchExport = memoize(
    async ({ serverUrl, token }: SyntheticalConfig) => {
      const projectInfo = await this.fetchProject({ serverUrl, token })
      const categoryList = await this.fetchApi<CategoryList>(
        `${serverUrl}/api/plugin/export`,
        {
          type: 'json',
          status: 'all',
          isWiki: 'false',
          token: token!,
        },
      )
      return categoryList.map(cat => {
        cat.list = (cat.list || []).map(item => {
          item.path = `${projectInfo.basepath}${item.path}`
          return item
        })
        return cat
      })
    },
    ({ serverUrl, token }: SyntheticalConfig) => `${serverUrl}|${token}`,
  )

  /** 获取分类的接口列表 */
  async fetchInterfaceList({
    serverUrl,
    token,
    id,
  }: SyntheticalConfig): Promise<InterfaceList> {
    const category = (
      (await this.fetchExport({ serverUrl, token })) || []
    ).find(
      cat => !isEmpty(cat) && !isEmpty(cat.list) && cat.list[0].catid === id,
    )

    if (category) {
      category.list.forEach(interfaceInfo => {
        // 实现 _category 字段
        interfaceInfo._category = omit(category, ['list'])
      })
    }

    return category ? category.list : []
  }

  /** 获取项目信息 */
  async fetchProjectInfo(syntheticalConfig: SyntheticalConfig) {
    const projectInfo = await this.fetchProject(syntheticalConfig)
    const projectCats = await this.fetchApi<CategoryList>(
      `${syntheticalConfig.serverUrl}/api/interface/getCatMenu`,
      {
        token: syntheticalConfig.token!,
        project_id: projectInfo._id,
      },
    )
    return {
      ...projectInfo,
      cats: projectCats,
      getMockUrl: () =>
        `${syntheticalConfig.serverUrl}/mock/${projectInfo._id}`,
      getDevUrl: (devEnvName: string) => {
        const env = projectInfo.env.find(e => e.name === devEnvName)
        return (env && env.domain) /* istanbul ignore next */ || ''
      },
      getProdUrl: (prodEnvName: string) => {
        const env = projectInfo.env.find(e => e.name === prodEnvName)
        return (env && env.domain) /* istanbul ignore next */ || ''
      },
    }
  }

  /** 生成接口代码 */
  async generateInterfaceCode(
    syntheticalConfig: SyntheticalConfig,
    interfaceInfo: Interface,
    categoryUID: string,
  ) {
    const extendedInterfaceInfo: ExtendedInterface = {
      ...interfaceInfo,
      parsedPath: path.parse(interfaceInfo.path),
    }
    const requestFunctionName = isFunction(
      syntheticalConfig.getRequestFunctionName,
    )
      ? await syntheticalConfig.getRequestFunctionName(
          extendedInterfaceInfo,
          changeCase,
        )
      : changeCase.camelCase(extendedInterfaceInfo.parsedPath.name)
    const requestConfigName = changeCase.camelCase(
      `${requestFunctionName}RequestConfig`,
    )
    const requestConfigTypeName = changeCase.pascalCase(requestConfigName)
    const requestDataTypeName = isFunction(
      syntheticalConfig.getRequestDataTypeName,
    )
      ? await syntheticalConfig.getRequestDataTypeName(
          extendedInterfaceInfo,
          changeCase,
        )
      : changeCase.pascalCase(`${requestFunctionName}Request`)
    const responseDataTypeName = isFunction(
      syntheticalConfig.getResponseDataTypeName,
    )
      ? await syntheticalConfig.getResponseDataTypeName(
          extendedInterfaceInfo,
          changeCase,
        )
      : changeCase.pascalCase(`${requestFunctionName}Response`)
    const requestDataJsonSchema = getRequestDataJsonSchema(
      extendedInterfaceInfo,
    )
    const requestDataType = await jsonSchemaToType(
      requestDataJsonSchema,
      requestDataTypeName,
    )
    const responseDataJsonSchema = getResponseDataJsonSchema(
      extendedInterfaceInfo,
      syntheticalConfig.dataKey,
    )
    const responseDataType = await jsonSchemaToType(
      responseDataJsonSchema,
      responseDataTypeName,
    )
    const isRequestDataOptional = /(\{\}|any)$/s.test(requestDataType)
    const requestHookName =
      syntheticalConfig.reactHooks && syntheticalConfig.reactHooks.enabled
        ? isFunction(syntheticalConfig.reactHooks.getRequestHookName)
          ? /* istanbul ignore next */
            await syntheticalConfig.reactHooks.getRequestHookName(
              extendedInterfaceInfo,
              changeCase,
            )
          : `use${changeCase.pascalCase(requestFunctionName)}`
        : ''

    // 支持路径参数
    const paramNames = (
      extendedInterfaceInfo.req_params /* istanbul ignore next */ || []
    ).map(item => item.name)
    const paramNamesLiteral = JSON.stringify(paramNames)
    const paramNameType =
      paramNames.length === 0 ? 'string' : `'${paramNames.join("' | '")}'`

    // 支持查询参数
    const queryNames = (
      extendedInterfaceInfo.req_query /* istanbul ignore next */ || []
    ).map(item => item.name)
    const queryNamesLiteral = JSON.stringify(queryNames)
    const queryNameType =
      queryNames.length === 0 ? 'string' : `'${queryNames.join("' | '")}'`

    // 接口注释
    const genComment = (genTitle: (title: string) => string) => {
      const {
        enabled: isEnabled = true,
        title: hasTitle = true,
        category: hasCategory = true,
        tag: hasTag = true,
        requestHeader: hasRequestHeader = true,
        updateTime: hasUpdateTime = true,
        link: hasLink = true,
      } = {
        ...syntheticalConfig.comment,
        // Swagger 时总是禁用标签、更新时间、链接
        ...(syntheticalConfig.serverType === 'swagger'
          ? {
              tag: false,
              updateTime: false,
              link: false,
            }
          : {}),
      } as CommentConfig
      if (!isEnabled) {
        return ''
      }
      // 转义标题中的 /
      const escapedTitle = String(extendedInterfaceInfo.title).replace(
        /\//g,
        '\\/',
      )
      const description = hasLink
        ? `[${escapedTitle}↗](${syntheticalConfig.serverUrl}/project/${extendedInterfaceInfo.project_id}/interface/api/${extendedInterfaceInfo._id})`
        : escapedTitle
      const summary: Array<
        | false
        | {
            label: string
            value: string | string[]
          }
      > = [
        hasCategory && {
          label: '分类',
          value: hasLink
            ? `[${extendedInterfaceInfo._category.name}↗](${syntheticalConfig.serverUrl}/project/${extendedInterfaceInfo.project_id}/interface/api/cat_${extendedInterfaceInfo.catid})`
            : extendedInterfaceInfo._category.name,
        },
        hasTag && {
          label: '标签',
          value: extendedInterfaceInfo.tag.map(tag => `\`${tag}\``),
        },
        hasRequestHeader && {
          label: '请求头',
          value: `\`${extendedInterfaceInfo.method.toUpperCase()} ${
            extendedInterfaceInfo.path
          }\``,
        },
        hasUpdateTime && {
          label: '更新时间',
          value: process.env.JEST_WORKER_ID // 测试时使用 unix 时间戳
            ? String(extendedInterfaceInfo.up_time)
            : /* istanbul ignore next */
              `\`${dayjs(extendedInterfaceInfo.up_time * 1000).format(
                'YYYY-MM-DD HH:mm:ss',
              )}\``,
        },
      ]
      const titleComment = hasTitle
        ? dedent`
            * ${genTitle(description)}
            *
          `
        : ''
      const extraComment: string = summary
        .filter(item => typeof item !== 'boolean' && !isEmpty(item.value))
        .map(item => {
          const _item: Exclude<typeof summary[0], boolean> = item as any
          return `* @${_item.label} ${castArray(_item.value).join(', ')}`
        })
        .join('\n')
      return dedent`
        /**
         ${[titleComment, extraComment].filter(Boolean).join('\n')}
         */
      `
    }

    return dedent`
      ${genComment(title => `接口 ${title} 的 **请求类型**`)}
      ${requestDataType.trim()}

      ${genComment(title => `接口 ${title} 的 **返回类型**`)}
      ${responseDataType.trim()}

      ${
        syntheticalConfig.typesOnly
          ? ''
          : dedent`
            ${genComment(title => `接口 ${title} 的 **请求配置的类型**`)}
            type ${requestConfigTypeName} = Readonly<RequestConfig<
              ${JSON.stringify(
                extendedInterfaceInfo._project.name.split('_')[0],
              )},
              ${JSON.stringify(syntheticalConfig.mockUrl)},
              ${JSON.stringify(extendedInterfaceInfo.path)},
              ${JSON.stringify(syntheticalConfig.dataKey) || 'undefined'},
              ${paramNameType},
              ${queryNameType},
              ${JSON.stringify(isRequestDataOptional)}
            >>

            ${genComment(title => `接口 ${title} 的 **请求配置**`)}
            const ${requestConfigName}: ${requestConfigTypeName} = {
              mockUrl: mockUrl${categoryUID},
              module: '${extendedInterfaceInfo._project.name.split('_')[0]}',
              path: ${JSON.stringify(extendedInterfaceInfo.path)},
              method: Method.${extendedInterfaceInfo.method},
              requestHeaders: ${JSON.stringify(
                (extendedInterfaceInfo.req_headers || [])
                  .filter(item => item.name.toLowerCase() !== 'content-type')
                  .reduce<Record<string, string>>((res, item) => {
                    res[item.name] = item.value
                    return res
                  }, {}),
              )},
              requestBodyType: RequestBodyType.${
                extendedInterfaceInfo.method === Method.GET
                  ? RequestBodyType.query
                  : extendedInterfaceInfo.req_body_type /* istanbul ignore next */ ||
                    RequestBodyType.none
              },
              responseBodyType: ResponseBodyType.${
                extendedInterfaceInfo.res_body_type
              },
              dataKey: dataKey${categoryUID},
              paramNames: ${paramNamesLiteral},
              queryNames: ${queryNamesLiteral},
              requestDataOptional: ${JSON.stringify(isRequestDataOptional)},
              requestDataJsonSchema: ${JSON.stringify(
                syntheticalConfig.jsonSchema?.enabled &&
                  syntheticalConfig.jsonSchema?.requestData !== false
                  ? requestDataJsonSchema
                  : {},
              )},
              responseDataJsonSchema: ${JSON.stringify(
                syntheticalConfig.jsonSchema?.enabled &&
                  syntheticalConfig.jsonSchema?.responseData !== false
                  ? responseDataJsonSchema
                  : {},
              )},
              requestFunctionName: ${JSON.stringify(requestFunctionName)},
            }

            ${genComment(title => `接口 ${title} 的 **请求函数**`)}
            export const ${requestFunctionName} = makeRequest<${requestDataTypeName}, ${responseDataTypeName}, ${requestConfigTypeName}>(${requestConfigName})

            ${
              !syntheticalConfig.reactHooks ||
              !syntheticalConfig.reactHooks.enabled
                ? ''
                : dedent`
                  ${genComment(title => `接口 ${title} 的 **React Hook**`)}
                  export const ${requestHookName} = makeRequestHook<${requestDataTypeName}, ${requestConfigTypeName}, ReturnType<typeof ${requestFunctionName}>>(${requestFunctionName})
                `
            }
          `
      }
    `
  }

  async destroy() {
    return Promise.all(this.disposes.map(async dispose => dispose()))
  }
}
