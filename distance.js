// utils.js

/**
 * 計算兩點經緯度之間的球體大圓距離 (Haversine Formula)
 * @param {number} lat1 點1緯度
 * @param {number} lon1 點1經度
 * @param {number} lat2 點2緯度
 * @param {number} lon2 點2經度
 * @returns {number} 距離 (公里 km)
 */

export const distance = (lat1, lon1, lat2, lon2) => {
  const R = 6371 // 地球半徑 (km)

  // 將角度轉為弧度
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distanceResult = R * c // 最終距離 (km)

  return distanceResult
}
