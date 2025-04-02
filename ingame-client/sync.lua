local addr, channel = ...
local address = addr .. "/channels"
local split = require("cc.strings").split

if channel then
  address = address .. "/" .. channel
end

if not channel then
  print("Sending channel request to http://" .. address)
  local request = http.get("http://" .. address)
  print(request);
  print(request.getResponseCode())
  local data = request.readAll()
  local channels = split(data, ",")
  local str = "Available channels:"
  for _,v in next, channels do
    str = str .. " " .. v
  end
  print(str)
  return
end

print("Connecting to websocket")
local ws = http.websocket("ws://" .. address)

local function ensureFile(path, data)
  local dir = split(path, "/")
  local currentDir = dir[1]
  if not fs.exists(currentDir) then
    if #dir == 1 then
      local f = fs.open(currentDir, "w")
      f.write(data)
      f.close()
    else
      fs.makeDir(currentDir)
    end
  else
    if #dir == 1 then
      local f = fs.open(currentDir, "w")
      f.write(data)
      f.close()
    end
  end
  if #dir == 1 then return end
  if #dir > 2 then
	  for i = 2, #currentDir - 1 do
      if not dir[i] then break end
		  currentDir = currentDir .. "/" .. dir[i]
		  if not fs.exists(currentDir) then 
		    fs.makeDir(currentDir)
		  end
	  end
  end
  currentDir = currentDir .. "/" .. dir[#dir]
  local file = fs.open(currentDir, "w")
  file.write(data)
  file.close()
end

local function walkUpTree(path)
  local path = splitString(path, "/")
  if #path == 1 then return end
  local currentPath = path[1]
  local function checkFolder(folder)
    print("checking folder " .. folder)
    local list = fs.list(folder)
    if #list == 0 then 
      print(folder .. " is empty, deleting")
      fs.delete(folder)
      return
    end
    print(folder .. " is not empty, checking children")
    for _,v in next, list do
      if fs.isDir(v) then checkFolder(folder .. "/" .. v) end
    end
  end
  checkFolder(currentPath)
end

while true do
  os.sleep(0)
  print("attempting to receive")
  local wsrecv = ws.receive()
  if wsrecv then
    local json = textutils.unserialiseJSON(wsrecv)
    local recv = json
    if recv.event == "change" then
      local fp = recv.filePath
      local fd = recv.data
      ensureFile(fp, fd)
    elseif recv.event == "remove" then
      if fs.exists(recv.filePath) then
        fs.delete(recv.filePath)
        walkUpTree(recv.filePath)
      end
    end
  end
end
