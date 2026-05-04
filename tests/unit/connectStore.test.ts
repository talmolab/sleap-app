import { describe, it, expect, beforeEach } from "vitest";
import { useConnectStore } from "@/stores/connectStore";

describe("connectStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useConnectStore.setState({
      credentials: null,
      connectionStatus: "disconnected",
      connectionError: null,
      roomId: null,
      workers: [],
      selectedWorkerId: null,
      _ws: null,
      _pc: null,
      _dc: null,
      _pendingFs: new Map(),
      _pendingJobs: new Map(),
    });
  });

  describe("setCredentials", () => {
    it("stores credentials", () => {
      const creds = {
        jwt: "test-jwt",
        username: "testuser",
        avatarUrl: "https://example.com/avatar.png",
        defaultRoom: "test-room",
      };
      useConnectStore.getState().setCredentials(creds);
      expect(useConnectStore.getState().credentials).toEqual(creds);
    });

    it("clears credentials with null", () => {
      useConnectStore.getState().setCredentials({
        jwt: "test",
        username: "user",
      });
      useConnectStore.getState().setCredentials(null);
      expect(useConnectStore.getState().credentials).toBeNull();
    });
  });

  describe("selectWorker", () => {
    it("sets selectedWorkerId", () => {
      useConnectStore.getState().selectWorker("worker-1");
      expect(useConnectStore.getState().selectedWorkerId).toBe("worker-1");
    });

    it("clears with null", () => {
      useConnectStore.getState().selectWorker("worker-1");
      useConnectStore.getState().selectWorker(null);
      expect(useConnectStore.getState().selectedWorkerId).toBeNull();
    });
  });

  describe("disconnect", () => {
    it("resets connection state", () => {
      useConnectStore.setState({
        connectionStatus: "connected",
        roomId: "test-room",
        workers: [
          {
            peerId: "w1",
            name: "worker-1",
            status: "available",
            mounts: [],
          },
        ],
        selectedWorkerId: "w1",
      });

      useConnectStore.getState().disconnect();

      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("disconnected");
      expect(state.roomId).toBeNull();
      expect(state.workers).toEqual([]);
      expect(state.selectedWorkerId).toBeNull();
    });
  });

  describe("initial state", () => {
    it("starts disconnected with no credentials", () => {
      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("disconnected");
      expect(state.credentials).toBeNull();
      expect(state.workers).toEqual([]);
    });
  });

  describe("_handleDataChannelMessage — JOB_LOG", () => {
    it("strips JOB_LOG prefix and routes text to pending job by ID", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_abc::Training epoch 1");
      expect(lines).toEqual(["Training epoch 1"]);
    });

    it("handles JOB_LOG with :: in the text body", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_abc::loss: 0.5 :: val: 0.3");
      expect(lines).toEqual(["loss: 0.5 :: val: 0.3"]);
    });

    it("ignores JOB_LOG for unknown job ID", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("JOB_LOG::job_xyz::Unknown job");
      expect(lines).toEqual([]);
    });
  });

  describe("_handleDataChannelMessage — AUTH messages not forwarded", () => {
    it("does not forward AUTH_CHALLENGE to pending jobs", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("AUTH_CHALLENGE::test-nonce");
      expect(lines).toEqual([]);
    });

    it("does not forward AUTH_SUCCESS to pending jobs", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("AUTH_SUCCESS");
      expect(lines).toEqual([]);
    });

    it("does not forward AUTH_FAILURE to pending jobs", () => {
      const lines: string[] = [];
      const pendingJobs = new Map();
      pendingJobs.set("job_abc", {
        onProgress: (line: string) => lines.push(line),
        onComplete: () => {},
        remainingCompletions: 1,
      });
      useConnectStore.setState({ _pendingJobs: pendingJobs });
      useConnectStore.getState()._handleDataChannelMessage("AUTH_FAILURE::invalid");
      expect(lines).toEqual([]);
    });
  });
});
