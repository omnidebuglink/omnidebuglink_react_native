/**
 * react-navigation hook for get_state's routes field.
 *
 * Flutter SDK uses a RouteObserver the host must attach to MaterialApp; the
 * RN equivalent is the NavigationService pattern. The host calls
 * setNavigator(navigationRef) once — get_state then reports the live route
 * stack. Not attached → get_state returns routes:null plus a hint.
 */
export interface NavRoute {
    key: string;
    name: string;
    params?: unknown;
}
export interface NavState {
    index: number;
    routes: NavRoute[];
}
export interface NavigatorLike {
    getState(): NavState | null | undefined;
}
export declare function setNavigator(nav: NavigatorLike | null): void;
export declare function getNavigatorState(): NavState | null;
//# sourceMappingURL=navigation.d.ts.map