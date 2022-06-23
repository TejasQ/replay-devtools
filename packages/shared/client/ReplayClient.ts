import {
  Message,
  ObjectId,
  ObjectPreviewLevel,
  PauseData,
  PauseId,
  SessionId,
  TimeStampedPoint,
  TimeStampedPointRange,
} from "@replayio/protocol";
// eslint-disable-next-line no-restricted-imports
import { client, initSocket } from "protocol/socket";
import { Pause, ThreadFront } from "protocol/thread";
import { compareNumericStrings } from "protocol/utils";

// TODO How should the client handle concurrent requests?
// Should we force serialization?
// Should we cancel in-flight requests and start new ones?

export interface ReplayClientInterface {
  configure(sessionId: string): void;
  getPauseIdForMessage(message: Message): PauseId;
  getSessionId(): SessionId | null;
  initialize(recordingId: string, accessToken: string | null): Promise<SessionId>;
  findMessages(focusRange: TimeStampedPointRange | null): Promise<{
    messages: Message[];
    overflow: boolean;
  }>;
  findSources(): Promise<void>;
  getObjectWithPreview(
    objectId: ObjectId,
    pauseId: PauseId,
    level?: ObjectPreviewLevel
  ): Promise<PauseData>;
  getPointNearTime(time: number): Promise<TimeStampedPoint>;
  getSessionEndpoint(sessionId: SessionId): Promise<TimeStampedPoint>;
}

export class ReplayClient implements ReplayClientInterface {
  private _dispatchURL: string;
  private _sessionId: SessionId | null = null;
  private _threadFront: typeof ThreadFront;

  constructor(dispatchURL: string, threadFront: typeof ThreadFront) {
    this._dispatchURL = dispatchURL;
    this._threadFront = threadFront;
  }

  private getSessionIdThrows(): SessionId {
    const sessionId = this._sessionId;
    if (sessionId === null) {
      throw Error("Invalid session");
    }
    return sessionId;
  }

  // Configures the client to use an already initialized session iD.
  // This method should be used for apps that use the protocol package directly.
  // Apps that only communicate with the Replay protocol through this client should use the initialize method instead.
  configure(sessionId: string): void {
    this._sessionId = sessionId;
  }

  getPauseIdForMessage(message: Message): PauseId {
    // Pause mutates the Message objects passed ot it.
    // We don't want that, so we have to deep clone the values first.
    const clonedMessage = JSON.parse(JSON.stringify(message));

    // TODO Create pauseId without the Pause; client.Session.createPause()
    const pause = new Pause(this._threadFront);
    pause.instantiate(
      clonedMessage.pauseId,
      clonedMessage.point.point,
      clonedMessage.point.time,
      !!clonedMessage.point.frame,
      clonedMessage.data
    );

    return pause.pauseId!;
  }

  getSessionId(): SessionId | null {
    return this._sessionId;
  }

  // Initializes the WebSocket and remote session.
  // This method should be used for apps that only communicate with the Replay protocol through this client.
  // Apps that use the protocol package directly should use the configure method instead.
  async initialize(recordingId: string, accessToken: string | null): Promise<SessionId> {
    const socket = initSocket(this._dispatchURL);
    await waitForOpenConnection(socket!);

    if (accessToken != null) {
      await client.Authentication.setAccessToken({ accessToken });
    }

    const { sessionId } = await client.Recording.createSession({ recordingId });

    this._sessionId = sessionId;
    this._threadFront.setSessionId(sessionId);

    return sessionId;
  }

  async findMessages(focusRange: TimeStampedPointRange | null): Promise<{
    messages: Message[];
    overflow: boolean;
  }> {
    const sessionId = this.getSessionIdThrows();

    if (focusRange !== null) {
      const response = await client.Console.findMessagesInRange(
        { range: { begin: focusRange.begin.point, end: focusRange.end.point } },
        sessionId
      );

      // Messages aren't guaranteed to arrive sorted, but unsorted messages aren't that useful to work with.
      // So sort them before returning.
      const sortedMessages = response.messages.sort((messageA: Message, messageB: Message) => {
        const pointA = messageA.point.point;
        const pointB = messageB.point.point;
        return compareNumericStrings(pointA, pointB);
      });

      return {
        messages: sortedMessages,
        overflow: response.overflow == true,
      };
    } else {
      const sortedMessages: Message[] = [];

      // TOOD This won't work if there are every overlapping requests.
      // Do we need to implement some kind of locking mechanism to ensure only one read is going at a time?
      client.Console.addNewMessageListener(({ message }) => {
        const newMessagePoint = message.point.point;

        // Messages may arrive out of order so let's sort them as we get them.
        let lowIndex = 0;
        let highIndex = sortedMessages.length;
        while (lowIndex < highIndex) {
          let middleIndex = (lowIndex + highIndex) >>> 1;
          const message = sortedMessages[middleIndex];

          if (compareNumericStrings(message.point.point, newMessagePoint)) {
            lowIndex = middleIndex + 1;
          } else {
            highIndex = middleIndex;
          }
        }

        const insertAtIndex = lowIndex;

        sortedMessages.splice(insertAtIndex, 0, message);
      });

      const response = await client.Console.findMessages({}, sessionId);

      client.Console.removeNewMessageListener();

      return {
        messages: sortedMessages,
        overflow: response.overflow == true,
      };
    }
  }

  async findSources(): Promise<void> {
    await this._threadFront.findSources(() => {
      // The demo doesn't use these directly, but the client throws if they aren't loaded.
    });
  }

  async getObjectWithPreview(
    objectId: ObjectId,
    pauseId: PauseId,
    level?: ObjectPreviewLevel
  ): Promise<PauseData> {
    const sessionId = this.getSessionIdThrows();
    const { data } = await client.Pause.getObjectPreview(
      { level, object: objectId },
      sessionId,
      pauseId || undefined
    );
    return data;
  }

  async getPointNearTime(time: number): Promise<TimeStampedPoint> {
    const sessionId = this.getSessionIdThrows();
    const { point } = await client.Session.getPointNearTime({ time: time }, sessionId);
    return point;
  }

  async getSessionEndpoint(sessionId: SessionId): Promise<TimeStampedPoint> {
    const { endpoint } = await client.Session.getEndpoint({}, sessionId);
    return endpoint;
  }
}

function waitForOpenConnection(
  socket: WebSocket,
  maxDurationMs = 2500,
  intervalMs = 100
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startTime = performance.now();
    const intervalId = setInterval(() => {
      if (performance.now() - startTime > maxDurationMs) {
        clearInterval(intervalId);
        reject(new Error("Timed out"));
      } else if (socket.readyState === socket.OPEN) {
        clearInterval(intervalId);
        resolve();
      }
    }, intervalMs);
  });
}