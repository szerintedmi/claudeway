import { DeepgramClient } from '@deepgram/sdk';
import type { VoiceProvider, AudioFormat, TranscriptionResult } from './voice.js';

export class DeepgramVoiceProvider implements VoiceProvider {
  private client: DeepgramClient;
  private sttModel: string;

  constructor(apiKey: string, sttModel = 'nova-3') {
    this.client = new DeepgramClient({ apiKey });
    this.sttModel = sttModel;
  }

  async transcribe(audio: Buffer, format: AudioFormat): Promise<TranscriptionResult> {
    const response = await this.client.listen.v1.media.transcribeFile(audio, {
      model: this.sttModel,
      smart_format: true,
      ...(format.mimeType ? { mimetype: format.mimeType } : {}),
      ...(format.sampleRate ? { sample_rate: format.sampleRate } : {}),
      ...(format.channels ? { channels: format.channels } : {}),
      ...(format.encoding ? { encoding: format.encoding } : {}),
    });

    // transcribeFile returns ListenV1Response | ListenV1AcceptedResponse
    // We need the synchronous response which has 'results'
    if (!('results' in response)) {
      throw new Error('Deepgram returned an async response — expected synchronous transcription');
    }

    const alternative = response.results?.channels?.[0]?.alternatives?.[0];
    return {
      transcript: alternative?.transcript ?? '',
      confidence: alternative?.confidence,
    };
  }
}
