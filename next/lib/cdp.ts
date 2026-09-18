// One websocket to the Notte session's browser. Every command is a promise, so commands that do not
// depend on each other are simply sent together and awaited together: a round trip is ~200 ms from far away.
import WebSocket from "ws";

const TIMEOUT = 30_000; // a remote browser can stall far longer than local Chrome

type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class Connection {
  private next = 1;
  private pending = new Map<number, Pending>();

  private constructor(private socket: WebSocket) {
    socket.on("message", (data) => {
      const reply = JSON.parse(data.toString());
      const waiting = this.pending.get(reply.id);
      if (!waiting) return; // events are not used
      this.pending.delete(reply.id);
      clearTimeout(waiting.timer);
      if (reply.error) waiting.reject(new Error(reply.error.message ?? "CDP error"));
      else waiting.resolve(reply.result ?? {});
    });
    socket.on("close", () => this.fail(new Error("The browser connection closed")));
    socket.on("error", (error) => this.fail(error));
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: TIMEOUT, maxPayload: 0 });
      socket.once("open", () => resolve(new Connection(socket)));
      socket.once("error", reject);
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }

  private fail(error: Error) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
