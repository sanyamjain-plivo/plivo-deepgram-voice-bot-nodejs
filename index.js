import WebSocket, { WebSocketServer } from 'ws';
import express from "express";
import http from 'http'
import { SettingsConfiguration } from "./SettingsConfiguration.js";
import dotenv from "dotenv";
import { SessionUpdate } from "./sessionUpdate.js";
import { getWeatherFromCityName } from "./functionCall.js";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();
const app = express()
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
let streamId = ""

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const successFilePath = __dirname + '/connectionSuccessfull.raw';
const errorFilePath = __dirname + '/SomethingWentWrong.raw';
const realtimeSuccessFilePath = __dirname + '/openaiSuccess.raw';
const realtimeErrorFilePath = __dirname + '/openaiError.raw';
const sampleWidth = 16;
const sampleRate = 8000;

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const socketConnectionList = {};

let client;
const PORT = 5000;

const { DEEPGRAM_API_KEY, OPENAI_API_KEY } = process.env

SessionUpdate.session.instructions = 'You are a helpful and a friendly AI assistant who loves to chat about anything the user is interested about.';
SessionUpdate.session.voice = 'alloy'

SettingsConfiguration.agent.think.prompt = 'You are a helpful and a friendly AI assistant who loves to chat about anything the user is interested about.';



app.post("/webhook", (request, reply) => {
  console.log('reques host is ', request.host)
  const PlivoXMLResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Stream streamTimeout="86400" keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000" audioTrack="inbound">
                                      ws://${request.host}/media-stream
                                  </Stream>
                              </Response>`;

  reply.type('text/xml').send(PlivoXMLResponse);
})

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const sendUpdateInstructions = (deepgramWs) => {
    deepgramWs.send(JSON.stringify(SettingsConfiguration))
}

const sendSessionUpdate = (realtimeWS) => {
  realtimeWS.send(JSON.stringify(SessionUpdate))
}

const playAudio = (fileName, plivoWS) => {
  let chunkSize = 20;

  if (plivoWS) {
    fs.readFile(fileName, (err, rawAudioData) => {
      if (err) {
        console.error('Error reading connectionSuccess.js file: ', err)
      } else {
        chunkSize = Number((sampleRate * sampleWidth * 1) * (chunkSize / 1000.0))
        console.log('chunkSize: ', chunkSize)
        for (let i = 0; i < rawAudioData.length; i += chunkSize) {
          const chunk = Buffer.from(rawAudioData.subarray(i, i + chunkSize), 'base64').toString('base64')
          const audioDelta = {
            event: 'playAudio',
            media: {
              contentType: 'audio/x-l16',
              sampleRate: 8000,
              payload: chunk
            }
          }
          plivoWS.send(JSON.stringify(audioDelta))
        }
      }
    })

  }
}

const startRealtimeWSConnection = (plivoWS) => {
  const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    }
  })

  realtimeWS.on('open', () => {
    console.log(`open ai websocket connected for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
    setTimeout(() => {
      sendSessionUpdate(realtimeWS)
    }, 250)
  })

  realtimeWS.on('close', () => {
    console.log(`Disconnected from the openAI Realtime API for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
  });

  realtimeWS.on('error', (error) => {
    console.log(`Error in the OpenAi Websocket for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId} and error: ${error}`)
    playAudio(realtimeErrorFilePath, plivoWS)
  })


  realtimeWS.on('message', async (message) => {
    try {
      const response = JSON.parse(message)

      switch (response.type) {
        case 'session.updated':
          console.log(`openai realtime session updated successfully for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
          playAudio(realtimeSuccessFilePath, plivoWS)
          break;
        case 'input_audio_buffer.speech_started':
          console.log('speech is started')

          const clearAudioData = {
            "event": "clearAudio",
            "stream_id": plivoWS.streamId
          }
          plivoWS.send(JSON.stringify(clearAudioData))

          const data = {
            "type": "response.cancel"
          }
          realtimeWS.send(JSON.stringify(data))
          break;
        case 'error':
          console.log(`error received in response for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId} and error: ${response}`)
          playAudio(realtimeErrorFilePath, plivoWS)
          break;
        case 'response.audio.delta':
          const audioDelta = {
            event: 'playAudio',
            media: {
              contentType: 'audio/x-mulaw',
              sampleRate: 8000,
              payload: Buffer.from(response.delta, 'base64').toString('base64')
            }
          }
          plivoWS.send(JSON.stringify(audioDelta));
          break;
        case 'response.function_call_arguments.done':
          console.log(`Function call request received from openai for ${response.name} for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`, response)
          if (response.name === 'getWeatherFromCityName') {
            const output = await getWeatherFromCityName(JSON.parse(response.arguments).city, process.env.OPENWEATHERMAP_API_KEY)
            const conversationItem = {
              type: "conversation.item.create",
              previous_item_id: null,
              item: {
                id: response.item_id,
                type: "function_call_output",
                call_id: response.call_id,
                output: output,
              }
            }
            realtimeWS.send(JSON.stringify(conversationItem))
            

            const generateResponse = {
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                temperature: 0.8,
                instructions: 'Please share the weather from the function call output with the user'
              }
            }

            realtimeWS.send(JSON.stringify(generateResponse))
          }
          break;
        default:
          console.log(`Response received from the Realtime API for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId} and response type: ${response.type}`)
      }
    } catch (error) {
      console.error(`Error processing openAI message for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId} and error: ${error} and raw message: ${message}`)
    }
  });
  return realtimeWS
}

const startDeepgramWSConnection = (plivoWS) => {
  let deepgramWs = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', {
    headers: {
      "Authorization": "Token " + DEEPGRAM_API_KEY,
    }
  })

  deepgramWs.on('open', () => {
    console.log(`DeepGram websocket connected for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
    sendUpdateInstructions(deepgramWs)
  })

  deepgramWs.on('close', () => {
    console.log(`Disconnected from the DeepGram API for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
  });

  deepgramWs.on('error', (error) => {
    console.log(`Error in the DeepGram Websocket for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId} and error: ${error}`)

    if (error.message.match('429')) {
      console.log(`Connecting to the OpenAI Realtime API for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
      //connect to the openAI RealTime connection
      deepgramWs = startRealtimeWSConnection(plivoWS)
      plivoWS.botConnected = deepgramWs
    } else {
      playAudio(errorFilePath, plivoWS)
    }
  })

  deepgramWs.on('message', async (message, isBinary) => {
    try {
        if (isBinary) {
            const audioDelta = {
                event: 'playAudio',
                media: {
                  contentType: 'audio/x-mulaw',
                  sampleRate: 8000,
                  payload: Buffer.from(message, 'base64').toString('base64')
                }
              }
              plivoWS.send(JSON.stringify(audioDelta));
        } else {
            const response = JSON.parse(message)
            switch (response.type) {
                case 'SettingsApplied':
                    console.log(`Settings successfully applied for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
                    playAudio(successFilePath, plivoWS)
                    break;
                case 'Welcome':
                    console.log(`Received welcome message for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
                    break;
                case 'UserStartedSpeaking':
                    console.log(`Speech is started for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
                    const data = {
                        "event": "clearAudio",
                        "stream_id": plivoWS.streamId
                    }
                    plivoWS.send(JSON.stringify(data))
                    break;
                case 'Error':
                    console.log(`Error in the DeepGram Websocket for streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
                    break;
                case 'FunctionCallRequest':
                    console.log(`Function call request getWeatherFromCityName received for  streamId: ${plivoWS.streamId} and callId: ${plivoWS.callId}`)
                    if (response.functions[0].name === 'getWeatherFromCityName') {
                      const city = JSON.parse(response.functions[0].arguments).city
                      const output = await getWeatherFromCityName(city, process.env.OPENWEATHERMAP_API_KEY)

                      const functionCallResponse = {
                          "type": "FunctionCallResponse",
                          "id": response.functions[0].id, 
                          "name": response.functions[0].name,
                          "content": output
                        }
                      deepgramWs.send(JSON.stringify(functionCallResponse))
                    }
                    break;
                default:
                    console.log(`Response received from the DeepGram API for streamId: ${plivoWS.streamId}, callId: ${plivoWS.callId} and response type: ${response.type}`)
            }
        }


    } catch (error) {
      console.error('Error processing DeepGram message: ', error, 'Raw message: ', message)
    }
  });
  return deepgramWs
}

wss.on('connection', (connection) => {
  console.log('Client connected to WebSocket');

  // start the DeepGram websocket connection
 


  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message)
      switch (data.event) {
        case 'media':
          if (connection.botConnected && connection.botConnected.readyState === WebSocket.OPEN) {
            if (connection.botConnected.url.includes('openai')) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }
              connection.botConnected.send(JSON.stringify(audioAppend))
            } else {
              connection.botConnected.send(Buffer.from(data.media.payload, 'base64'))
            }
          }
          break;
        case 'start':
          console.log(`Incoming stream has started for streamId: ${data.start.streamId} and callId: ${data.start.callId}`)
          // streamId = data.start.streamId
          const botConnection = startDeepgramWSConnection(connection);
          connection.botConnected = botConnection
          connection.streamId = data.start.streamId
          connection.callId = data.start.callId
          break;
        default:
          console.log(`Received non-media event for streamId: ${connection.streamId} and callId: ${connection.callId}`)
          break
      }
    } catch (error) {
      console.error(`Error parsing message for streamId: ${connection.streamId} and callId: ${connection.callId} and error: ${error} and message: ${message}`)
    }
  });

  connection.on('close', () => {
    console.log(`Client disconnected for streamId: ${connection.streamId} and callId: ${connection.callId}`)
    if (connection.botConnected.readyState === WebSocket.OPEN) {
      connection.botConnected.close()
      connection.botConnected = null;
    }
  });


});


server.listen(PORT, () => {
  console.log('server started on port 5000')
});
