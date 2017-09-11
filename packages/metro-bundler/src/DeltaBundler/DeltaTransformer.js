/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

'use strict';

const DeltaCalculator = require('./DeltaCalculator');

const {EventEmitter} = require('events');

import type {RawMapping} from '../Bundler/source-map';
import type Bundler from '../Bundler';
import type {Options as JSTransformerOptions} from '../JSTransformer/worker';
import type Resolver from '../Resolver';
import type {MappingsMap} from '../lib/SourceMap';
import type Module from '../node-haste/Module';
import type {Options as BundleOptions} from './';

type DeltaEntry = {|
  +code: string,
  +map: ?Array<RawMapping>,
  +name: string,
  +path: string,
  +source: string,
|};

export type DeltaEntries = Map<number, ?DeltaEntry>;

export type DeltaTransformResponse = {|
  +pre: DeltaEntries,
  +post: DeltaEntries,
  +delta: DeltaEntries,
  +inverseDependencies: {[key: string]: $ReadOnlyArray<string>},
  +reset: boolean,
|};

type Options = {|
  +getPolyfills: ({platform: ?string}) => $ReadOnlyArray<string>,
  +polyfillModuleNames: $ReadOnlyArray<string>,
|};

/**
 * This class is in charge of creating the delta bundle with the actual
 * transformed source code for each of the modified modules. For each modified
 * module it returns a `DeltaModule` object that contains the basic information
 * about that file. Modules that have been deleted contain a `null` module
 * parameter.
 *
 * The actual return format is the following:
 *
 *   {
 *     pre: [{id, module: {}}],   Scripts to be prepended before the actual
 *                                modules.
 *     post: [{id, module: {}}],  Scripts to be appended after all the modules
 *                                (normally the initial require() calls).
 *     delta: [{id, module: {}}], Actual bundle modules (dependencies).
 *   }
 */
class DeltaTransformer extends EventEmitter {
  _bundler: Bundler;
  _getPolyfills: ({platform: ?string}) => $ReadOnlyArray<string>;
  _polyfillModuleNames: $ReadOnlyArray<string>;
  _getModuleId: ({path: string}) => number;
  _deltaCalculator: DeltaCalculator;
  _bundleOptions: BundleOptions;
  _currentBuildPromise: ?Promise<DeltaTransformResponse>;

  constructor(
    bundler: Bundler,
    deltaCalculator: DeltaCalculator,
    options: Options,
    bundleOptions: BundleOptions,
  ) {
    super();

    this._bundler = bundler;
    this._deltaCalculator = deltaCalculator;
    this._getPolyfills = options.getPolyfills;
    this._polyfillModuleNames = options.polyfillModuleNames;
    this._getModuleId = this._bundler.getGetModuleIdFn();
    this._bundleOptions = bundleOptions;

    this._deltaCalculator.on('change', this._onFileChange);
  }

  static async create(
    bundler: Bundler,
    options: Options,
    bundleOptions: BundleOptions,
  ): Promise<DeltaTransformer> {
    const deltaCalculator = await DeltaCalculator.create(
      bundler,
      bundleOptions,
    );

    return new DeltaTransformer(
      bundler,
      deltaCalculator,
      options,
      bundleOptions,
    );
  }

  /**
   * Destroy the Delta Transformer and its calculator. This should be used to
   * clean up memory and resources once this instance is not used anymore.
   */
  end() {
    this._deltaCalculator.removeListener('change', this._onFileChange);

    return this._deltaCalculator.end();
  }

  /**
   * Main method to calculate the bundle delta. It returns a DeltaResult,
   * which contain the source code of the modified and added modules and the
   * list of removed modules.
   */
  async getDelta(): Promise<DeltaTransformResponse> {
    // If there is already a build in progress, wait until it finish to start
    // processing a new one (delta transformer doesn't support concurrent
    // builds).
    if (this._currentBuildPromise) {
      await this._currentBuildPromise;
    }

    this._currentBuildPromise = this._getDelta();

    let result;

    try {
      result = await this._currentBuildPromise;
    } finally {
      this._currentBuildPromise = null;
    }

    return result;
  }

  async _getDelta(): Promise<DeltaTransformResponse> {
    // Calculate the delta of modules.
    const {modified, deleted, reset} = await this._deltaCalculator.getDelta();

    const transformerOptions = this._deltaCalculator.getTransformerOptions();
    const dependencyPairs = this._deltaCalculator.getDependencyPairs();
    const resolver = await this._bundler.getResolver();

    // Get the transformed source code of each modified/added module.
    const modifiedDelta = await this._transformModules(
      Array.from(modified.values()),
      resolver,
      transformerOptions,
      dependencyPairs,
    );

    deleted.forEach(id => {
      modifiedDelta.set(this._getModuleId({path: id}), null);
    });

    // Return the source code that gets prepended to all the modules. This
    // contains polyfills and startup code (like the require() implementation).
    const prependSources = reset
      ? await this._getPrepend(transformerOptions, dependencyPairs)
      : new Map();

    // Return the source code that gets appended to all the modules. This
    // contains the require() calls to startup the execution of the modules.
    const appendSources = reset
      ? await this._getAppend(
          dependencyPairs,
          this._deltaCalculator.getModulesByName(),
        )
      : new Map();

    // Inverse dependencies are needed for HMR.
    const inverseDependencies = this._getInverseDependencies(
      this._deltaCalculator.getInverseDependencies(),
    );

    return {
      pre: prependSources,
      post: appendSources,
      delta: modifiedDelta,
      inverseDependencies,
      reset,
    };
  }

  async _getPrepend(
    transformOptions: JSTransformerOptions,
    dependencyPairs: Map<string, $ReadOnlyArray<[string, Module]>>,
  ): Promise<DeltaEntries> {
    const resolver = await this._bundler.getResolver();

    // Get all the polyfills from the relevant option params (the
    // `getPolyfills()` method and the `polyfillModuleNames` variable).
    const polyfillModuleNames = this._getPolyfills({
      platform: this._bundleOptions.platform,
    }).concat(this._polyfillModuleNames);

    // The module system dependencies are scripts that need to be included at
    // the very beginning of the bundle (before any polyfill).
    const moduleSystemDeps = resolver.getModuleSystemDependencies({
      dev: this._bundleOptions.dev,
    });

    const modules = moduleSystemDeps.concat(
      polyfillModuleNames.map((polyfillModuleName, idx) =>
        resolver.getDependencyGraph().createPolyfill({
          file: polyfillModuleName,
          id: polyfillModuleName,
          dependencies: [],
        }),
      ),
    );

    return await this._transformModules(
      modules,
      resolver,
      transformOptions,
      dependencyPairs,
    );
  }

  async _getAppend(
    dependencyPairs: Map<string, $ReadOnlyArray<[string, Module]>>,
    modulesByName: Map<string, Module>,
  ): Promise<DeltaEntries> {
    const resolver = await this._bundler.getResolver();

    // Get the absolute path of the entry file, in order to be able to get the
    // actual correspondant module (and its moduleId) to be able to add the
    // correct require(); call at the very end of the bundle.
    const absPath = resolver
      .getDependencyGraph()
      .getAbsolutePath(this._bundleOptions.entryFile);
    const entryPointModule = await this._bundler.getModuleForPath(absPath);

    // First, get the modules correspondant to all the module names defined in
    // the `runBeforeMainModule` config variable. Then, append the entry point
    // module so the last thing that gets required is the entry point.
    return new Map(
      this._bundleOptions.runBeforeMainModule
        .map(name => modulesByName.get(name))
        .concat(entryPointModule)
        .filter(Boolean)
        .map(this._getModuleId)
        .map(moduleId => {
          const code = `;require(${JSON.stringify(moduleId)});`;
          const name = 'require-' + String(moduleId);
          const path = name + '.js';

          return [
            moduleId,
            {
              code,
              map: null,
              name,
              source: code,
              path,
            },
          ];
        }),
    );
  }

  /**
   * Converts the paths in the inverse dependendencies to module ids.
   */
  _getInverseDependencies(
    inverseDependencies: Map<string, Set<string>>,
  ): {[key: string]: $ReadOnlyArray<string>} {
    const output = Object.create(null);

    for (const [key, dependencies] of inverseDependencies) {
      output[this._getModuleId({path: key})] = Array.from(
        dependencies,
      ).map(dep => this._getModuleId({path: dep}));
    }

    return output;
  }

  async _transformModules(
    modules: Array<Module>,
    resolver: Resolver,
    transformOptions: JSTransformerOptions,
    dependencyPairs: Map<string, $ReadOnlyArray<[string, Module]>>,
  ): Promise<DeltaEntries> {
    return new Map(
      await Promise.all(
        modules.map(module =>
          this._transformModule(
            module,
            resolver,
            transformOptions,
            dependencyPairs,
          ),
        ),
      ),
    );
  }

  async _transformModule(
    module: Module,
    resolver: Resolver,
    transformOptions: JSTransformerOptions,
    dependencyPairs: Map<string, $ReadOnlyArray<[string, Module]>>,
  ): Promise<[number, ?DeltaEntry]> {
    const [name, metadata] = await Promise.all([
      module.getName(),
      this._getMetadata(module, transformOptions),
    ]);

    const dependencyPairsForModule = dependencyPairs.get(module.path) || [];

    const wrapped = this._bundleOptions.wrapModules
      ? await resolver.wrapModule({
          module,
          getModuleId: this._getModuleId,
          dependencyPairs: dependencyPairsForModule,
          dependencyOffsets: metadata.dependencyOffsets || [],
          name,
          code: metadata.code,
          map: metadata.map,
          minify: this._bundleOptions.minify,
          dev: this._bundleOptions.dev,
        })
      : {
          code: resolver.resolveRequires(
            module,
            this._getModuleId,
            metadata.code,
            dependencyPairsForModule,
            metadata.dependencyOffsets || [],
          ),
          map: metadata.map,
        };

    // Ignore the Source Maps if the output of the transformer is not our
    // custom rawMapping data structure, since the Delta bundler cannot process
    // them. This can potentially happen when the minifier is enabled (since
    // uglifyJS only returns standard Source Maps).
    const map = Array.isArray(wrapped.map) ? wrapped.map : undefined;

    return [
      this._getModuleId(module),
      {
        code: wrapped.code,
        map,
        name,
        source: metadata.source,
        path: module.path,
      },
    ];
  }

  async _getMetadata(
    module: Module,
    transformOptions: JSTransformerOptions,
  ): Promise<{
    +code: string,
    +dependencyOffsets: ?Array<number>,
    +map: ?MappingsMap,
    +source: string,
  }> {
    if (module.isAsset()) {
      const asset = await this._bundler.generateAssetObjAndCode(
        module,
        this._bundleOptions.assetPlugins,
        this._bundleOptions.platform,
      );

      return {
        code: asset.code,
        dependencyOffsets: asset.meta.dependencyOffsets,
        map: undefined,
        source: '',
      };
    }

    return await module.read(transformOptions);
  }

  _onFileChange = () => {
    this.emit('change');
  };
}

module.exports = DeltaTransformer;