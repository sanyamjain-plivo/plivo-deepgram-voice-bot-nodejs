export const SettingsConfiguration = {
  "type": "Settings",
  "audio": {
    "input": {
      "encoding": "mulaw",
      "sample_rate": 8000
    },
    "output": {
      "encoding": "mulaw",
      "sample_rate": 8000,
      "container": "none",
    }
  },
  "agent": {
    "listen": { 
      "provider": { 
        "type": "deepgram",
        "model": "nova-3" 
      },
    },
    "think": {
      "provider": {
        "type": "open_ai",
        "model": "gpt-4o-mini" 
      },
      "prompt": "You are a helpful assistant.",
      "functions": [
        {
          "name": "getWeatherFromCityName",
          "description": "Get the weather from the given city name",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string",
                "description": "The city name to get the weather from"
              }
            },
            "required": ["city"]
          },
        }
      ]
    },
    "speak": {
      "provider": {
        "type": "deepgram",
        "model": "aura-asteria-en"
      }
    }
  }
}
