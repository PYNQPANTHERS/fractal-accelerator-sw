memoization , any clever caching? 
ie static data by critical processes. 

----
ui
--
can we addexpandable overlay to main page called tune - thatt allows use to set these changable apramters eg margion, quality of panning rendering etc etc ie any key paramters --  any key  - also adding fps overlay button so we can see on both pages -- maybe alsoe xperitemnt with how fats people are allowed to pan this could help -- and lsit optmisations for me so we not what we have done / what may need removing
---
live evolution panning still seems smoother thanperofrmance whihc is obviosuly wrong for some reaosn .

----
 

 temporal delta encoding ?  - only send the pixels that changed 
 -- is this pure , is actually worth ? 

 ----
 so much smoother moving to 4x4 over 5x5 why is this? 

 ---
 performance mode seems to be twice as slow as live evolution latency wise, when I would expectt eh opposite, should be the same thing, just julia renders after we stop panning --- why is that, is it not just a schedueling difference? -- look into the performance implementation 