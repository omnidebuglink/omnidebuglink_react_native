#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(OmlReactModule, NSObject)

RCT_EXTERN_METHOD(screenshot:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(uiTree:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(tap:(nonnull NSNumber *)x
                     y:(nonnull NSNumber *)y
                 reject:(RCTPromiseRejectBlock)reject
                resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(longPress:(nonnull NSNumber *)x
                        y:(nonnull NSNumber *)y
                durationMs:(nonnull NSNumber *)durationMs
                    reject:(RCTPromiseRejectBlock)reject
                   resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(swipe:(nonnull NSNumber *)x1
                    y1:(nonnull NSNumber *)y1
                    x2:(nonnull NSNumber *)x2
                    y2:(nonnull NSNumber *)y2
             durationMs:(nonnull NSNumber *)durationMs
                 reject:(RCTPromiseRejectBlock)reject
                resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(clickView:(nonnull NSNumber *)fieldId
                  reject:(RCTPromiseRejectBlock)reject
                 resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(inputText:(nonnull NSNumber *)fieldId
                      text:(nonnull NSString *)text
                    reject:(RCTPromiseRejectBlock)reject
                   resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(sendKey:(nonnull NSString *)key
                   reject:(RCTPromiseRejectBlock)reject
                  resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getPerf:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(viewComponent:(nonnull NSNumber *)fieldId
                          reject:(RCTPromiseRejectBlock)reject
                         resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(prefsGet:(nonnull NSString *)key
                     reject:(RCTPromiseRejectBlock)reject
                    resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(prefsSet:(NSDictionary)opts
                    reject:(RCTPromiseRejectBlock)reject
                   resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(prefsDelete:(nonnull NSString *)key
                        reject:(RCTPromiseRejectBlock)reject
                       resolve:(RCTPromiseResolveBlock)resolve)

RCT_EXTERN_METHOD(prefsList:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(exitApp)

@end
