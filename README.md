# CC:T Syncing Server

A primarily [cc-tstl-template](https://github.com/MCJack123/cc-tstl-template) oriented CC:T sync server.

Made because I didn't want to manually enter everything and the other tools I could find didn't serve the sole purpose of syncing files, instead being either a turtle remote access tool or a turtle emulator.

project.json structure:
```json5
{
    "rootDir": "dir", // The directory to search for files in. This is relative to where you're running the server, so "." would resolve to the current directory, and "build" would resolve to "currentDirectory/build"
    "project": [     // This is where we declare the various channels available to clients.
        {
           "type": "library", // Can be "library" or "script", "library" channels can be requirements for other channels, library or script.
           "files": ["lib1/test.lua"], // All the files this channel contains. Optional as long as directories is declared.
           "channelName": "testlib", // The channel the client has to connect to in order to sync these files.
           "directories": ["lib1/subdir"], // Folders that should be watched for this channel. Optional as long as files is declared.
           "requiredChannels": ["testreq"] // The channels required for this channel to function. Circular dependencies are not handled and should be avoided.
        }
    ]
}
```

If you wish to sync multiple channels at once, a single client can request to connect to several channels.

Upon connection, the first packet sent is a "subscribe" packet, detailing the channels the client wishes to sync.

If a "GET" request is sent to "/", we respond with all available channels and their types.

I don't know how to make a sort of "sourcemap" to ensure the client can remove files that are no longer in the project, especially seeing as there's multiple channels to connect to, so auto-removing files is not a feature. If I work on this further, I might try to add that.

## Config 

You can configure the server by editing server/config.json.

```json5
{
    "port": 10234, // The port to host the Express server on. If you are connecting to localhost, the address should be localhost:port
    "minify": false // Should we minify the Lua code sent to the turtle? This is helpful if you wish to save space but will make debugging a pain.
}
```

## Initial client setup

Setting up a client is fairly simple.

In order to get the syncing script, run `wget {host-url}/sync.lua`

`{host-url}` should either be a URL logged in the console (adding http://) or your own domain, depending on how you choose to run this.

If running this on the same computer, you can just run `wget http://localhost:10234/sync.lua` if you've set up your config to allow local connections.

To get all available channels, run `sync {host-url}`

To connect to channels, run `sync {host-url} channels`, ex. `sync localhost:10234 testlib1 testlib2`

## Credits

msgpack.lua is from https://github.com/kieselsteini/msgpack

I forgot where base64.lua is from, but I remember it being from some roblox devforum thread.
