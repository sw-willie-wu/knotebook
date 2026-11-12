// #334 最愛 DTO。清單只帶「哪一篇、何時加入」；標題與位置由呼叫端從筆記清單取。

export interface FavoriteDto {
  noteId: string;
  /** ISO 8601，毫秒精度；加入最愛的時間。 */
  favoritedAt: string;
}
