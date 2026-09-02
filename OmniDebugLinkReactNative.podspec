require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "OmniDebugLinkReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.description  = package["description"]
  s.homepage     = package["repository"]
  s.license      = package["license"]
  s.authors      = { "OmniDebugLink" => "support@omnidebuglink.dev" }
  s.platforms    = { :ios => "13.0" }
  s.source       = { :git => package["repository"], :tag => "v#{s.version.to_s}" }
  s.source_files = "ios/**/*.{h,m,swift}"
  s.swift_version = "5.0"

  # React-Core provides the React module (RCTPromiseResolveBlock, UIView+React)
  s.dependency "React-Core"
end
