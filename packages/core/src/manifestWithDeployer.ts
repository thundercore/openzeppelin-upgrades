import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { EthereumProvider, getChainId, getHardhatMetadata, networkNames } from './provider';
import lockfile from 'proper-lockfile';
import { compare as compareVersions } from 'compare-versions';

import type { Deployment } from './deployment';
import type { StorageLayout } from './storage';
import { pick } from './utils/pick';
import { mapValues } from './utils/map-values';
import { UpgradesError } from './error';
import debug from './utils/debug';
import { assert } from './utils/assert';

const currentManifestVersion = '3.2';

export interface ManifestData {
  manifestVersion: string;
  impls: {
    [version in string]?: ImplDeployment;
  };
  proxies: ProxyDeployment[];
  deployer: string;
  admin?: Deployment;
}

export interface ImplDeployment extends Deployment {
  layout: StorageLayout;
  allAddresses?: string[];
}

export interface ProxyDeployment extends Deployment {
  kind: 'uups' | 'transparent' | 'beacon';
}

export function defaultManifest(): ManifestData[] {
  return [
    {
      manifestVersion: currentManifestVersion,
      impls: {},
      proxies: [],
      deployer: '',
    },
  ];
}

const MANIFEST_DEFAULT_DIR = '.openzeppelin';
const MANIFEST_TEMP_DIR = 'openzeppelin-upgrades';

async function getDevInstanceMetadata(
  provider: EthereumProvider,
  chainId: number,
): Promise<DevInstanceMetadata | undefined> {
  let hardhatMetadata;

  try {
    hardhatMetadata = await getHardhatMetadata(provider);
  } catch (e: unknown) {
    return undefined;
  }

  if (hardhatMetadata.chainId !== chainId) {
    throw new Error(
      `Broken invariant: Hardhat metadata's chainId ${hardhatMetadata.chainId} does not match eth_chainId ${chainId}`,
    );
  }

  return {
    networkName: 'hardhat',
    instanceId: hardhatMetadata.instanceId,
    forkedNetwork: hardhatMetadata.forkedNetwork,
  };
}

function getSuffix(chainId: number, devInstanceMetadata?: DevInstanceMetadata) {
  if (devInstanceMetadata !== undefined) {
    return `${chainId}-${devInstanceMetadata.instanceId}`;
  } else {
    return `${chainId}`;
  }
}

interface DevInstanceMetadata {
  networkName: string;
  instanceId: string;
  forkedNetwork?: {
    // The chainId of the network that is being forked
    chainId: number;
  };
}

export class ManifestWithDeployer {
  readonly chainId: number;
  readonly file: string;
  readonly fallbackFile: string;
  readonly deployer: string;
  private readonly dir: string;

  private readonly chainIdSuffix: string;
  private readonly parent?: ManifestWithDeployer;

  private locked = false;

  static async forNetwork(provider: EthereumProvider, deployer: string): Promise<ManifestWithDeployer> {
    const chainId = await getChainId(provider);
    const devInstanceMetadata = await getDevInstanceMetadata(provider, chainId);
    if (devInstanceMetadata !== undefined) {
      return new ManifestWithDeployer(chainId, deployer, devInstanceMetadata, os.tmpdir());
    } else {
      return new ManifestWithDeployer(chainId, deployer);
    }
  }

  constructor(chainId: number, deployer: string, devInstanceMetadata?: DevInstanceMetadata, osTmpDir?: string) {
    this.chainId = chainId;
    this.chainIdSuffix = getSuffix(chainId, devInstanceMetadata);
    this.deployer = deployer;

    const defaultFallbackName = `unknown-${chainId}`;

    if (devInstanceMetadata !== undefined) {
      assert(osTmpDir !== undefined);
      this.dir = path.join(osTmpDir, MANIFEST_TEMP_DIR);
      debug('development manifest directory:', this.dir);

      const devName = `${devInstanceMetadata.networkName}-${this.chainIdSuffix}`;
      const devFile = path.join(this.dir, `${devName}.json`);

      this.file = devFile;
      if (chainId === 31337) {
        this.fallbackFile = path.join(MANIFEST_DEFAULT_DIR, `${defaultFallbackName}.json`);
      } else {
        this.fallbackFile = devFile;
      }
      debug('development manifest file:', this.file, 'fallback file:', this.fallbackFile);

      if (devInstanceMetadata.forkedNetwork !== undefined) {
        const forkedChainId = devInstanceMetadata.forkedNetwork.chainId;
        debug('forked network chain id:', forkedChainId);

        this.parent = new ManifestWithDeployer(forkedChainId, this.deployer);
      }
    } else {
      this.dir = MANIFEST_DEFAULT_DIR;

      const networkName = networkNames[chainId];
      this.file = path.join(MANIFEST_DEFAULT_DIR, `${networkName ?? defaultFallbackName}.json`);
      this.fallbackFile = path.join(MANIFEST_DEFAULT_DIR, `${defaultFallbackName}.json`);

      debug('manifest file:', this.file, 'fallback file:', this.fallbackFile);
    }
  }

  async getAdmin(): Promise<Deployment | undefined> {
    return (await this.read()).admin;
  }

  async getDeploymentFromAddress(address: string): Promise<ImplDeployment> {
    const data = await this.read();
    const deployment = Object.values(data.impls).find(
      d => d?.address === address || d?.allAddresses?.includes(address),
    );

    if (deployment === undefined) {
      throw new DeploymentNotFound(`Deployment at address ${address} is not registered`);
    }
    return deployment;
  }

  async getProxyFromAddress(address: string): Promise<ProxyDeployment> {
    const data = await this.read();
    const deployment = data.proxies.find(d => d?.address === address);
    if (deployment === undefined) {
      throw new DeploymentNotFound(`Proxy at address ${address} is not registered`);
    }
    return deployment;
  }

  async addProxy(proxy: ProxyDeployment): Promise<void> {
    await this.lockedRun(async () => {
      const manifest = await this.readAll();
      const index = manifest.findIndex(d => d.deployer === this.deployer);
      let data: ManifestData;
      if (index === -1) {
        data = defaultManifest()[0];
      } else {
        data = manifest[index];
      }
      const existing = data.proxies.findIndex(p => p.address === proxy.address);
      if (existing >= 0) {
        data.proxies.splice(existing, 1);
      }
      data.proxies.push(proxy);

      manifest[index] = data;

      await this.write(manifest);
    });
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch (e: any) {
      return false;
    }
  }

  private async readFile(): Promise<string> {
    if (this.file === this.fallbackFile) {
      return await fs.readFile(this.file, 'utf8');
    } else {
      const fallbackExists = await this.exists(this.fallbackFile);
      const fileExists = await this.exists(this.file);

      if (fileExists && fallbackExists) {
        throw new UpgradesError(
          `Network files with different names ${this.fallbackFile} and ${this.file} were found for the same network.`,
          () =>
            `More than one network file was found for chain ID ${this.chainId}. Determine which file is the most up to date version, then take a backup of and delete the other file.`,
        );
      } else if (fallbackExists) {
        return await fs.readFile(this.fallbackFile, 'utf8');
      } else {
        return await fs.readFile(this.file, 'utf8');
      }
    }
  }

  private async writeFile(content: string): Promise<void> {
    await this.renameFileIfRequired();
    await fs.writeFile(this.file, content);
  }

  private async renameFileIfRequired() {
    if (this.file !== this.fallbackFile && (await this.exists(this.fallbackFile))) {
      try {
        await fs.rename(this.fallbackFile, this.file);
      } catch (e: any) {
        throw new Error(`Failed to rename network file from ${this.fallbackFile} to ${this.file}: ${e.message}`);
      }
    }
  }

  async read() {
    const data = (await this.readAll()).find(d => d.deployer === this.deployer);
    if (data === undefined) {
      throw new Error(`No deployment found for ${this.deployer}`);
    }
    return data;
  }

  async readAll(retries?: number): Promise<ManifestData[]> {
    const release = this.locked ? undefined : await this.lock(retries);
    try {
      const data = JSON.parse(await this.readFile()) as ManifestData[];
      return validateOrUpdateManifestVersion(data);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        if (this.parent !== undefined) {
          return await this.parent.readAll(retries);
        } else {
          return defaultManifest();
        }
      } else {
        throw e;
      }
    } finally {
      await release?.();
    }
  }

  async write(data: ManifestData[]): Promise<void> {
    if (!this.locked) {
      throw new Error('Manifest must be locked');
    }
    const normalized = normalizeManifestData(data);
    await this.writeFile(JSON.stringify(normalized, null, 2) + '\n');
  }

  async lockedRun<T>(cb: () => Promise<T>): Promise<T> {
    if (this.locked) {
      throw new Error('Manifest is already locked');
    }
    const release = await this.lock();
    try {
      return await cb();
    } finally {
      await release();
    }
  }

  private async lock(retries = 3) {
    const lockfileName = path.join(this.dir, `chain-${this.chainIdSuffix}`);

    await fs.mkdir(path.dirname(lockfileName), { recursive: true });
    const release = await lockfile.lock(lockfileName, { retries, realpath: false });
    this.locked = true;
    return async () => {
      await release();
      this.locked = false;
    };
  }
}

function validateOrUpdateManifestVersion(data: ManifestData[]): ManifestData[] {
  const manifest: ManifestData[] = [];
  data.forEach(datum => {
    if (typeof datum.manifestVersion !== 'string') {
      throw new Error('Manifest version is missing');
    } else if (compareVersions(datum.manifestVersion, '3.0', '<')) {
      throw new Error('Found a manifest file for OpenZeppelin CLI. An automated migration is not yet available.');
    } else if (compareVersions(datum.manifestVersion, currentManifestVersion, '<')) {
      manifest.push(migrateManifest(datum));
    } else if (datum.manifestVersion === currentManifestVersion) {
      manifest.push(datum);
    } else {
      throw new Error(`Unknown value for manifest version (${datum.manifestVersion})`);
    }
  });
  return manifest;
}

export function migrateManifest(data: ManifestData): ManifestData {
  switch (data.manifestVersion) {
    case '3.0':
    case '3.1':
      data.manifestVersion = currentManifestVersion;
      data.proxies = [];
      return data;
    default:
      throw new Error('Manifest migration not available');
  }
}

export class DeploymentNotFound extends Error {}

export function normalizeManifestData(input: ManifestData[]): ManifestData[] {
  return input.map(datum => ({
    manifestVersion: datum.manifestVersion,
    admin: datum.admin && normalizeDeployment(datum.admin),
    proxies: datum.proxies.map(p => normalizeDeployment(p, ['kind'])),
    impls: mapValues(datum.impls, i => i && normalizeDeployment(i, ['layout', 'allAddresses'])),
    deployer: datum.deployer,
  }));
}

function normalizeDeployment<D extends Deployment>(input: D): Deployment;
function normalizeDeployment<D extends Deployment, K extends keyof D>(input: D, include: K[]): Deployment & Pick<D, K>;
function normalizeDeployment<D extends Deployment, K extends keyof D>(
  input: D,
  include: K[] = [],
): Deployment & Pick<D, K> {
  return pick(input, ['address', 'txHash', ...include]);
}
