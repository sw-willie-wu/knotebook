/**
 * SetupState：一次性 setup 流程的狀態機介面。
 *
 * 本檔（Task 7）只先建立 stub 介面，供 `buildApp` 的 deps 型別使用——`buildApp` 需要在
 * deps 就位（含 setupState）之後才完整，但真正的實作（查 instance_setup、產生/驗證
 * setup token）留給 Task 8 的 `SetupState` class。
 */
export interface SetupState {
  isNeeded(): Promise<boolean>;
  verifyToken(t: string): boolean;
}
