import {
  BleTransport,
  parseBlePredictionPayload,
  BlePredictionPayload,
} from '../src/ble/bleTransport';
import { GloveController } from '../src/ble/controller';
import { CaptureController } from '../src/ml/capture';
import type { GloveTransport, TransportStatus } from '../src/ble/types';
import type { RawSample } from '../src/sensors/types';

describe('Embedded BLE Prediction and 3.0s Capture Tests', () => {
  describe('parseBlePredictionPayload', () => {
    it('correctly parses a complete and valid firmware prediction packet', () => {
      const json = JSON.stringify({
        v: 1,
        glove: 'right',
        model_v: '1.0.0',
        label: 'HELLO',
        status: 'valid',
        score: 0.942,
        margin: 0.485,
      });

      const parsed = parseBlePredictionPayload(json);
      expect(parsed).not.toBeNull();
      expect(parsed?.v).toBe(1);
      expect(parsed?.glove).toBe('right');
      expect(parsed?.model_v).toBe('1.0.0');
      expect(parsed?.label).toBe('HELLO');
      expect(parsed?.status).toBe('valid');
      expect(parsed?.score).toBeCloseTo(0.942);
      expect(parsed?.margin).toBeCloseTo(0.485);
    });

    it('maps warming_up and unknown statuses properly', () => {
      const warming = parseBlePredictionPayload(JSON.stringify({ label: 'NONE', status: 'warming_up', glove: 'left' }));
      expect(warming?.status).toBe('warming_up');
      expect(warming?.glove).toBe('left');

      const unknown = parseBlePredictionPayload(JSON.stringify({ label: '?', status: 'unknown' }));
      expect(unknown?.status).toBe('unknown');
    });

    it('returns null for non-JSON or missing label payload', () => {
      expect(parseBlePredictionPayload('NOT_A_VALID_JSON{')).toBeNull();
      expect(parseBlePredictionPayload(JSON.stringify({ foo: 'bar' }))).toBeNull();
    });
  });

  describe('BleTransport prediction handling', () => {
    it('notifies subscribers and tracks last prediction', () => {
      const transport = new BleTransport();
      const received: BlePredictionPayload[] = [];
      const unsub = transport.onPrediction((p) => received.push(p));

      transport.handlePredictionJsonForTesting(
        JSON.stringify({
          v: 1,
          glove: 'right',
          model_v: '1.0.0',
          label: 'YES',
          status: 'valid',
          score: 0.88,
        })
      );

      expect(received.length).toBe(1);
      expect(received[0].label).toBe('YES');
      expect(transport.getLastPrediction()?.label).toBe('YES');

      unsub();
      transport.handlePredictionJsonForTesting(
        JSON.stringify({ label: 'NO', status: 'valid' })
      );
      expect(received.length).toBe(1); // Unsubscribed
    });

    it('clears lastPrediction on disconnect', async () => {
      const transport = new BleTransport();
      transport.handlePredictionJsonForTesting(
        JSON.stringify({ label: 'HELLO', status: 'valid' })
      );
      expect(transport.getLastPrediction()?.label).toBe('HELLO');

      await transport.disconnect();
      expect(transport.getLastPrediction()).toBeNull();
    });
  });

  describe('GloveController prediction snapshot integration', () => {
    it('updates snapshot when prediction arrives and clears on disconnect', async () => {
      let statusCb: ((s: TransportStatus) => void) | null = null;
      let predCb: ((p: BlePredictionPayload) => void) | null = null;

      const mockTransport: GloveTransport & { onPrediction: (fn: (p: BlePredictionPayload) => void) => () => void } = {
        name: 'MockTransport',
        isSynthetic: false,
        getStatus: () => ({ kind: 'connected', side: 'right', deviceName: 'MockGlove' }),
        onStatusChange: (cb: (s: TransportStatus) => void) => {
          statusCb = cb;
          return () => { statusCb = null; };
        },
        subscribe: (_cb: (s: RawSample) => void) => () => {},
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockImplementation(async () => {
          if (statusCb) statusCb({ kind: 'disconnected', side: 'right', reason: 'User requested disconnect' });
        }),
        scan: jest.fn().mockResolvedValue([]),
        onPrediction: (cb: (p: BlePredictionPayload) => void) => {
          predCb = cb;
          return () => { predCb = null; };
        },
      };

      const controller = new GloveController('right', mockTransport);
      expect(controller.getSnapshot().prediction).toBeNull();

      // Trigger prediction
      expect(predCb).not.toBeNull();
      predCb!({
        v: 1,
        glove: 'right',
        model_v: '1.0.0',
        label: 'THANK YOU',
        status: 'valid',
        score: 0.95,
        margin: 0.52,
      });

      expect(controller.getSnapshot().prediction?.label).toBe('THANK YOU');
      expect(controller.getSnapshot().prediction?.score).toBe(0.95);

      // Disconnect clears snapshot prediction
      await controller.disconnect();
      expect(controller.getSnapshot().prediction).toBeNull();
    });
  });

  describe('CaptureController 3.0s window and error handling', () => {
    function makeCapture(sinkOverrides?: Partial<any>) {
      const sink = {
        saveSample: jest.fn().mockResolvedValue(undefined),
        putPendingWindow: jest.fn().mockResolvedValue(undefined),
        saveSession: jest.fn().mockResolvedValue(undefined),
        markRejected: jest.fn().mockResolvedValue(undefined),
        ...sinkOverrides,
      };
      let counter = 0;
      const capture = new CaptureController({
        sink,
        newId: () => `id-${++counter}`,
        now: () => 1000 + counter * 100,
      });
      return { capture, sink };
    }

    it('initializes with exact 3.0s window duration (3000ms)', () => {
      const { capture } = makeCapture();
      expect(capture.getSnapshot().targetMs).toBe(3000);
      expect(capture.getSnapshot().phase).toBe('idle');
    });

    it('preserves awaiting-label state when saveSample throws an error', async () => {
      const { capture, sink } = makeCapture({
        saveSample: jest.fn().mockRejectedValue(new Error('Storage quota exceeded')),
      });

      await capture.startSession({
        languageId: 'isl',
        modality: 'glove-sensor',
        source: 'glove',
        side: 'left',
        deviceLabel: 'SanketVaanni-Left',
        calibrationVersion: 1,
        handContext: 'left',
      });

      capture.beginWindow();

      // Push 35 frames with > 3000ms elapsed
      for (let i = 0; i < 35; i++) {
        capture.pushFrame({
          side: 'left',
          timestampMs: 1000 + i * 100,
          flex: [0.1, 0.2, 0.0, 0.0, 0.3],
          accel: { x: 0.1, y: 0.2, z: 0.98 },
          gyro: { x: 0.0, y: 0.01, z: -0.01 },
        });
      }

      expect(capture.getSnapshot().phase).toBe('awaiting-label');

      // Attempt confirm with label - should fail gracefully without crashing
      const res = await capture.confirm('HELLO');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('Storage quota exceeded');
      }

      // Crucial: state remains awaiting-label so user can retry or correct
      expect(capture.getSnapshot().phase).toBe('awaiting-label');
      expect(sink.saveSample).toHaveBeenCalledTimes(1);
    });

    it('successfully confirms, sets label, side and resets to ready', async () => {
      let savedSample: any = null;
      const { capture } = makeCapture({
        saveSample: jest.fn().mockImplementation(async (sample) => {
          savedSample = sample;
        }),
      });

      await capture.startSession({
        languageId: 'isl',
        modality: 'glove-sensor',
        source: 'glove',
        side: 'right',
        deviceLabel: 'SanketVaanni-Right',
        calibrationVersion: 1,
        handContext: 'right',
      });

      capture.beginWindow();

      for (let i = 0; i < 35; i++) {
        capture.pushFrame({
          side: 'right',
          timestampMs: 1000 + i * 100,
          flex: [0.5, 0.5, 0.5, 0.5, 0.5],
          accel: { x: 0.0, y: 0.0, z: 1.0 },
          gyro: { x: 0.0, y: 0.0, z: 0.0 },
        });
      }

      expect(capture.getSnapshot().phase).toBe('awaiting-label');
      const confirmRes = await capture.confirm('BYE');
      expect(confirmRes.ok).toBe(true);

      expect(capture.getSnapshot().phase).toBe('ready');
      expect(savedSample).not.toBeNull();
      expect(savedSample.labelId).toBe('BYE');
      expect(savedSample.side).toBe('right');
      expect(savedSample.frames.length).toBe(30);
      expect(savedSample.source).toBe('glove');
    });
  });
});
