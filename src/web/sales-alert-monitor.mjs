// Alerts use imported data only. No additional Amazon requests are made here.
export function startSalesAlertMonitor(repository,{intervalMs=15*60*1000}={}) {
  let busy=false,closed=false;
  const refresh=async()=>{
    if(busy||closed)return;
    busy=true;
    try{await repository.syncSalesAlerts();}
    catch{console.warn('SALES_ALERT_ANALYSIS_FAILED');}
    finally{busy=false;}
  };
  const timer=setInterval(refresh,intervalMs);timer.unref();
  void refresh();
  return()=>{closed=true;clearInterval(timer);};
}
