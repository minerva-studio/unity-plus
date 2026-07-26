import type { UnityPlusLogger } from '../../unity/logger';
import { discoverUnityTests } from './testDiscovery';
import { executeUnityTests } from './testExecution';
import { createUnityTestBridge, type UnityTestBridgeClient } from './unityTestBridge';
import type {
  UnityTestBackend,
  UnityTestBackendRunRequest,
  UnityTestDiscoveryResult
} from './unityTestBackend';

/** Runs Unity tests through the Visual Studio Editor package IDE messaging protocol. */
export class EditorPackageUnityTestBackend implements UnityTestBackend {
  private bridge: UnityTestBridgeClient | undefined;

  /** Creates a backend while preserving the existing injectable bridge fixture. */
  constructor(
    private readonly logger: UnityPlusLogger,
    private readonly createBridge: () => UnityTestBridgeClient = createUnityTestBridge
  ) {}

  /** Revalidates the project endpoint before every discovery operation. */
  async discover(projectRoot: string): Promise<UnityTestDiscoveryResult> {
    return discoverUnityTests(await this.getBridge(projectRoot));
  }

  /** Revalidates the endpoint and delegates the established result lifecycle unchanged. */
  async run(request: UnityTestBackendRunRequest): Promise<void> {
    let executionStarted = false;

    try {
      const bridge = await this.getBridge(request.projectRoot);
      if (request.token.isCancellationRequested) {
        request.run.end();
        return;
      }

      executionStarted = true;
      await executeUnityTests(
        bridge,
        request.run,
        request.batches,
        request.token,
        this.logger,
        request.itemByFullName
      );
    } catch (error) {
      // The execution helper owns TestRun completion after its protocol lifecycle starts.
      if (!executionStarted) {
        request.run.end();
      }
      throw error;
    }
  }

  /** Disconnects the persistent bridge owned by this backend. */
  dispose(): void {
    this.bridge?.disconnect();
    this.bridge = undefined;
  }

  /** Creates the bridge once and validates its live project endpoint on every operation. */
  private async getBridge(projectRoot: string): Promise<UnityTestBridgeClient> {
    if (!this.bridge) {
      this.bridge = this.createBridge();
      this.bridge.onError(error => this.logger.warn(`Unity test bridge: ${error.message}`));
    }

    await this.bridge.connect(projectRoot);
    return this.bridge;
  }
}
