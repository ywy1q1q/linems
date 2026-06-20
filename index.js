import 'dotenv/config'
import linebot from 'linebot'
import { distance } from './distance.js'

let tdxAccessToken = ''
let tokenExpiryTime = 0
let cachedBikeData = []
const lastLocationByUser = new Map()

const bot = linebot({
  channelId: process.env.CHANNEL_ID,
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
})

async function fetchTdxToken() {
  const tokenUrl =
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
  const clientId = process.env.TDX_CLIENT_ID
  const clientSecret = process.env.TDX_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    console.error('❌ 錯誤：找不到環境變數 TDX_CLIENT_ID 或 TDX_CLIENT_SECRET')
    return false
  }

  if (tdxAccessToken && Date.now() < tokenExpiryTime - 5 * 60 * 1000) {
    return true
  }

  try {
    console.log('🔑 [TDX 認證] 正在向 TDX 伺服器申請/更新 Token...')
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    const data = await response.json()
    if (data.access_token) {
      tdxAccessToken = data.access_token

      tokenExpiryTime = Date.now() + (data.expires_in || 3600) * 1000
      console.log('🔑 [TDX 認證] 通行證更新成功！')
      return true
    }
    console.error('❌ [TDX 認證] 驗證失敗：', data)
    return false
  } catch (error) {
    console.error('❌ [TDX 認證] 連線驗證伺服器失敗:', error)
    return false
  }
}

async function getCityYouBikeData(cityName) {
  const hasToken = await fetchTdxToken()
  if (!hasToken || !tdxAccessToken) {
    console.error(`❌ [${cityName}] 無法取得有效 Token，取消資料抓取。`)
    return []
  }

  try {
    const headers = { Authorization: `Bearer ${tdxAccessToken}` }

    const [stationRes, availabilityRes] = await Promise.all([
      fetch(
        `https://tdx.transportdata.tw/api/basic/v2/Bike/Station/City/${cityName}?%24top=4000&%24format=JSON`,
        { headers },
      ),
      fetch(
        `https://tdx.transportdata.tw/api/basic/v2/Bike/Availability/City/${cityName}?%24top=4000&%24format=JSON`,
        { headers },
      ),
    ])

    if (!stationRes.ok || !availabilityRes.ok) {
      console.error(`❌ [${cityName}] HTTP 請求失敗:`, {
        stationStatus: stationRes.status,
        availabilityStatus: availabilityRes.status,
      })
      return []
    }

    const stations = await stationRes.json()
    const availabilities = await availabilityRes.json()

    if (!Array.isArray(stations) || !Array.isArray(availabilities)) {
      console.error(`❌ [${cityName}] API 回應格式異常`)
      return []
    }

    const availabilityMap = new Map(availabilities.map((item) => [item.StationID, item]))

    return stations.map((station) => {
      const liveInfo = availabilityMap.get(station.StationID)
      const rawName = station.StationName?.Zh_tw || ''
      const address = station.StationAddress?.Zh_tw || ''
      const backupTown = station.TownName || ''

      let district = ''
      const matchAddress = address.match(/(?:台北市|臺北市|新北市)(.*?區)/)
      if (matchAddress && matchAddress[1]) {
        district = matchAddress[1].trim()
      } else {
        const matchName = rawName.match(/_(.*?區)_/)
        if (matchName && matchName[1]) {
          district = matchName[1].trim()
        } else if (backupTown && backupTown !== '未知區域') {
          district = backupTown.trim()
        }
      }

      if (!district) {
        district = cityName === 'Taipei' ? '大安區' : '板橋區'
      }

      return {
        name: rawName,
        city: cityName === 'Taipei' ? '臺北市' : '新北市',
        district: district,
        address: address,
        generalBikes: liveInfo?.AvailableRentBikesDetail?.GeneralBikes ?? 0,
        electricBikes: liveInfo?.AvailableRentBikesDetail?.ElectricBikes ?? 0,
        emptySlots: liveInfo?.AvailableReturnBikes ?? 0,
        lat: Number(station.StationPosition?.PositionLat),
        lng: Number(station.StationPosition?.PositionLon),
      }
    })
  } catch (error) {
    console.error(`❌ [${cityName}] 資料抓取失敗:`, error)
    return []
  }
}

async function updateYouBikeCache() {
  console.log('⏳ [背景作業] 開始同步 TDX 雙北 YouBike 資料...')
  try {
    const tpeData = await getCityYouBikeData('Taipei')

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const ntpcData = await getCityYouBikeData('NewTaipei')

    if (tpeData.length === 0 && ntpcData.length === 0) {
      console.error('⚠️ [背景作業] 雙北資料皆為空，不覆蓋舊快取。')
      return
    }

    cachedBikeData = [...tpeData, ...ntpcData]
    console.log(`✅ [背景作業] 雙北資料快取更新成功！共 ${cachedBikeData.length} 個站點。`)
  } catch (err) {
    console.error('更新快取發生未知錯誤:', err)
  }
}

function getSourceId(event) {
  return event.source?.userId || event.source?.groupId || event.source?.roomId || 'unknown'
}

async function replyNearbyStations(event, latitude, longitude) {
  const allStations = cachedBikeData

  if (allStations.length === 0) {
    return event.reply('系統初始化中，請稍後再試！')
  }

  const result = allStations
    .map((station) => {
      const mappedStation = { ...station }
      mappedStation.distance = distance(
        latitude,
        longitude,
        mappedStation.lat,
        mappedStation.lng,
        'k',
      )
      return mappedStation
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)

  console.log('最近的3個站點：', result)

  const bubbles = result.map((station) => {
    const meters = Math.round(station.distance * 1000)
    const cleanName = station.name.replace('YouBike2.0_', '')

    return {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://apis.youbike.com.tw/images/675c84258769704fb305f135/6949ebc8ccc89.jpg',
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${station.city}`,
            size: 'xs',
            color: '#D9B300',
            weight: 'bold',
          },
          {
            type: 'text',
            text: cleanName,
            weight: 'bold',
            size: 'xl',
            color: '#64A600',
          },
          {
            type: 'text',
            text: station.address,
            weight: 'regular',
            size: 'xs',
            color: '#6C6C6C',
            decoration: 'underline',
            align: 'start',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'baseline',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                size: 'sm',
                text: '📍 距離',
                weight: 'bold',
              },
              {
                type: 'text',
                text: `${meters} 公尺`,
                color: '#0066CC',
                weight: 'bold',
                size: 'md',
              },
            ],
            margin: 'md',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'xs',
            spacing: 'md',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '🚲   一般車 (2.0) ',
                    size: 'sm',
                    weight: 'bold',
                    margin: 'md',
                  },
                  {
                    type: 'text',
                    text: String(station.generalBikes),
                    weight: 'bold',
                    offsetStart: '30px',
                  },
                ],
                margin: 'md',
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '⚡ 電輔車 (2.0E) ',
                    size: 'sm',
                    weight: 'bold',
                    margin: 'md',
                  },
                  {
                    type: 'text',
                    text: String(station.electricBikes),
                    weight: 'bold',
                    offsetStart: '30px',
                  },
                ],
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'md',
                contents: [
                  { type: 'text', text: '🅿️ 空位 ', size: 'sm', weight: 'bold', margin: 'md' },
                  {
                    type: 'text',
                    text: String(station.emptySlots),
                    weight: 'bold',
                    offsetStart: '30px',
                  },
                ],
                margin: 'md',
              },
              {
                type: 'separator',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📍 導航前往',

              uri: `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`,
            },
          },
        ],
        flex: 0,
      },
    }
  })

  const perfectPayload = {
    type: 'flex',
    altText: '🚲 為您找到周邊最近的 YouBike 站點',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
    quickReply: {
      items: [
        {
          type: 'action',
          imageUrl: 'https://cdn-icons-png.flaticon.com/512/854/854878.png',
          action: {
            type: 'location',
            label: '📍 分享當前位置',
          },
        },
        {
          type: 'action',
          imageUrl: 'https://cdn-icons-png.flaticon.com/512/3585/3585891.png',
          action: {
            type: 'message',
            label: '🔄 重新查詢',
            text: '查詢附近 YouBike',
          },
        },
      ],
    },
  }

  await event.reply(perfectPayload)
  console.log('✅ [LINE] Carousel 卡片與快速回應選單已完美同步發送！')
}

bot.on('message', async (event) => {
  try {
    if (event.message.type === 'text') {
      const text = event.message.text?.trim()
      const sourceId = getSourceId(event)

      if (
        text === '查詢附近 YouBike' ||
        text === '重新查詢' ||
        text === '再次查詢' ||
        text === '查詢附近'
      ) {
        const cachedLocation = lastLocationByUser.get(sourceId)
        if (cachedLocation) {
          return replyNearbyStations(event, cachedLocation.latitude, cachedLocation.longitude)
        }

        return event.reply({
          type: 'text',
          text: '請分享您現在的位置，我會幫您重新查詢附近的 YouBike。',
          quickReply: {
            items: [
              {
                type: 'action',
                imageUrl: 'https://cdn-icons-png.flaticon.com/512/854/854878.png',
                action: {
                  type: 'location',
                  label: '📍 分享當前位置',
                },
              },
            ],
          },
        })
      }

      if (text === '找車') {
        return event.reply({
          type: 'text',
          text: '💡 好的！請點選下方按鈕傳送您當前的位置（或輸入您想查詢的地址附近位置），我就能幫您尋找周邊的 YouBike 站點囉！',
          quickReply: {
            items: [
              {
                type: 'action',
                imageUrl: 'https://cdn-icons-png.flaticon.com/512/854/854878.png',
                action: {
                  type: 'location',
                  label: '📍 點我傳送位置',
                },
              },
            ],
          },
        })
      }

      await event.reply(text || '我收到了您的訊息，但請點選「查詢附近 YouBike」或分享位置來查詢。')
    } else if (event.message.type === 'location') {
      const sourceId = getSourceId(event)
      lastLocationByUser.set(sourceId, {
        latitude: event.message.latitude,
        longitude: event.message.longitude,
      })

      return replyNearbyStations(event, event.message.latitude, event.message.longitude)
    }
  } catch (error) {
    console.error('處理訊息發生錯誤:', error)
  }
})

async function initPipeline() {
  await updateYouBikeCache()

  setInterval(updateYouBikeCache, 60 * 1000)

  bot.listen('/', process.env.PORT || 3000, () => {
    console.log('🚀 YouBike 機器人已成功啟動並開始監聽！')
  })
}

initPipeline()
