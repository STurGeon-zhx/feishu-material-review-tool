import { randomUUID } from "node:crypto";
import { SingleFlight } from "../core/single-flight";
import type { AppDatabase } from "../db/client";
import {
  createOrGetProject,
  getActiveProject,
  getCurrentDestination,
  getProject,
  getProjectByCreateKey,
  getPendingEnsureProject,
  hasPendingProjectAssets,
  lockDestinationRebuild,
  unlockDestinationRebuild,
} from "../db/repository";

interface DestinationSetup {
  run(projectId: string): Promise<ReturnType<typeof getActiveProject> extends infer T ? NonNullable<T> : never>;
}

function timestampSuffix(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}`;
}

export class DestinationManager {
  private readonly ensureFlight = new SingleFlight<NonNullable<ReturnType<typeof getActiveProject>>>();
  private activeRebuild?: {
    key: string;
    promise: Promise<NonNullable<ReturnType<typeof getActiveProject>>>;
  };
  private activeRetry?: Promise<NonNullable<ReturnType<typeof getActiveProject>>>;

  constructor(
    private readonly db: AppDatabase,
    private readonly setup: DestinationSetup,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getActive() {
    return getActiveProject(this.db);
  }

  getCurrent() {
    return getCurrentDestination(this.db);
  }

  ensure(createKey: string) {
    const active = this.getActive();
    if (active) return Promise.resolve(active);
    return this.ensureFlight.run("destination-ensure", async () => {
      const latest = this.getActive();
      if (latest) return latest;
      const pending = getPendingEnsureProject(this.db);
      if (pending) return this.setup.run(pending.id);
      const project = createOrGetProject(this.db, {
        id: this.createId(),
        createKey: `ensure:${createKey}`,
        localUserId: "service_app",
        name: "客户素材审核",
        requestedShareMode: "anyone_editable",
        resourceType: "sheet",
      });
      return this.setup.run(project.id);
    });
  }

  rebuild(createKey: string) {
    const normalizedKey = `rebuild:${createKey}`;
    if (this.activeRebuild) {
      if (this.activeRebuild.key === normalizedKey) return this.activeRebuild.promise;
      return Promise.reject(Object.assign(new Error("已有审核表重建请求正在处理，请稍后重试"), {
        code: "DESTINATION_MUTATION_IN_PROGRESS",
        retryable: true,
      }));
    }
    if (this.activeRetry) {
      return Promise.reject(Object.assign(new Error("已有审核表配置请求正在处理，请稍后重试"), {
        code: "DESTINATION_MUTATION_IN_PROGRESS",
        retryable: true,
      }));
    }
    const promise = this.runRebuild(normalizedKey).finally(() => {
      if (this.activeRebuild?.promise === promise) this.activeRebuild = undefined;
    });
    this.activeRebuild = { key: normalizedKey, promise };
    return promise;
  }

  retry() {
    if (this.activeRebuild) {
      return Promise.reject(Object.assign(new Error("审核表正在重建，请稍后再重试配置"), {
        code: "DESTINATION_MUTATION_IN_PROGRESS",
        retryable: true,
      }));
    }
    if (this.activeRetry) return this.activeRetry;
    const destination = this.getCurrent();
    if (!destination || destination.setupStatus === "ready") {
      return Promise.reject(Object.assign(new Error("没有需要重试的审核表配置"), {
        code: "DESTINATION_RETRY_NOT_AVAILABLE",
        retryable: false,
      }));
    }
    const promise = this.setup.run(destination.id).finally(() => {
      if (this.activeRetry === promise) this.activeRetry = undefined;
    });
    this.activeRetry = promise;
    return promise;
  }

  private async runRebuild(normalizedKey: string) {
    const existing = getProjectByCreateKey(this.db, normalizedKey);
    if (existing?.setupStatus === "ready"
      || (existing?.setupStatus === "partial" && existing.setupStep === "share_permission_failed")) {
      return existing;
    }
    const active = this.getActive();
    if (!active) {
      throw Object.assign(new Error("请先创建固定审核表，再执行重建"), {
        code: "DESTINATION_NOT_INITIALIZED",
        retryable: false,
      });
    }
    if (hasPendingProjectAssets(this.db, active.id)) {
      throw Object.assign(new Error("当前审核表仍有未完成素材，请完成或重试后再重建"), {
        code: "DESTINATION_HAS_PENDING_IMPORTS",
        retryable: true,
      });
    }
    lockDestinationRebuild(this.db, active.id);
    try {
      const project = createOrGetProject(this.db, {
        id: this.createId(),
        createKey: normalizedKey,
        localUserId: "service_app",
        name: `客户素材审核-${timestampSuffix(this.now())}`,
        requestedShareMode: "anyone_editable",
        resourceType: "sheet",
      });
      return project.setupStatus === "ready"
        || (project.setupStatus === "partial" && project.setupStep === "share_permission_failed")
        ? project
        : await this.setup.run(project.id);
    } finally {
      unlockDestinationRebuild(this.db, active.id);
    }
  }
}
